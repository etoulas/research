/* Sizing + throughput model — a direct port of vram_model.py.
   Kept in its own file so it can be unit-checked against the Python. */
const KV_TYPE_BYTES = { f16: 2.0, q8_0: 1.0625, q5_1: 0.75, q4_0: 0.5625 };
const GIB = 1024 ** 3;

function kvBytes(model, ctx, kvType, pessimistic) {
  const e = KV_TYPE_BYTES[kvType];
  const groups = (pessimistic && model.layer_groups_alt_mha) ? model.layer_groups_alt_mha : model.layer_groups;
  let total = 0;
  for (const g of groups) {
    if (g.type === "attention_full") {
      total += g.count * 2 * g.n_kv_heads * g.head_dim * e * (g.kv_share_factor ?? 1) * ctx;
    } else if (g.type === "attention_swa") {
      total += g.count * 2 * g.n_kv_heads * g.head_dim * e * Math.min(ctx, g.window);
    } else if (g.type === "attention_mla") {
      total += g.count * (g.kv_lora_rank + g.qk_rope_head_dim) * e * ctx;
    } else if (g.type === "linear_state") {
      total += g.count * g.state_bytes_per_layer;
    }
  }
  return total;
}

function weightSplit(model, quant) {
  const fileBytes = model.quants[quant].bytes;
  const bpp = fileBytes / model.params_total;
  if (model.kind === "dense") return [fileBytes, 0, 0];
  const frac = model.n_experts_active / model.n_experts;
  const expertParams = (model.params_total - model.params_active) / (1 - frac);
  const nonExpertParams = model.params_total - expertParams;
  return [nonExpertParams * bpp, expertParams * bpp, expertParams * frac * bpp];
}

function evaluate(cfg, model, quant, ctx, kvType, cpuMoeFrac, specMult, pessimistic, ov) {
  ov = ov || {};
  const hw = cfg.hardware, d = cfg.defaults;
  const effGpu = ov.eff_gpu ?? d.eff_gpu, effCpu = ov.eff_cpu ?? d.eff_cpu;
  const perThread = ov.cpu_bytes_per_s_per_thread ?? d.cpu_bytes_per_s_per_thread;
  const vramBudget = ov.vram_usable_bytes ?? hw.gpu.vram_usable_bytes;

  const bwGpu = hw.gpu.bandwidth_bytes_per_s * effGpu;
  const bwCpu = Math.min(hw.cpu.ram_bandwidth_bytes_per_s * effCpu, hw.cpu.threads * perThread);

  const [nonExp, expTot, expAct] = weightSplit(model, quant);
  const dense = model.kind === "dense";
  let wGpu, wCpu, readGpu, readCpu;
  if (dense) {
    wCpu = nonExp * cpuMoeFrac; wGpu = nonExp - wCpu; readGpu = wGpu; readCpu = wCpu;
  } else {
    const expCpu = expTot * cpuMoeFrac;
    wGpu = nonExp + (expTot - expCpu); wCpu = expCpu;
    readGpu = nonExp + expAct * (1 - cpuMoeFrac); readCpu = expAct * cpuMoeFrac;
  }
  const kv = kvBytes(model, ctx, kvType, pessimistic);
  const vramUsed = wGpu + kv + d.compute_buffer_bytes + d.cuda_ctx_bytes;
  const overhead = wCpu > 0 ? d.overhead_s_per_token_hybrid : d.overhead_s_per_token_gpu_only;
  const tTok = readGpu / bwGpu + readCpu / bwCpu + kv / bwGpu + overhead;

  return {
    fits: vramUsed <= vramBudget, vramUsed, vramBudget,
    weightsGpu: wGpu, weightsCpu: wCpu, kv,
    compute: d.compute_buffer_bytes + d.cuda_ctx_bytes,
    readGpu, readCpu, cpuMoeFrac, tps: specMult / tTok,
    tGpuMs: 1000 * readGpu / bwGpu, tCpuMs: 1000 * readCpu / bwCpu,
    tKvMs: 1000 * kv / bwGpu, tOvhMs: 1000 * overhead, dense,
  };
}

function bestConfig(cfg, model, quant, ctx, kvType, specMult, pessimistic, ov) {
  const ramBudget = cfg.hardware.cpu.ram_bytes * 0.75;
  for (let i = 0; i < 201; i++) {
    const frac = i / 200;
    const r = evaluate(cfg, model, quant, ctx, kvType, frac, specMult, pessimistic, ov);
    if (r.fits && r.weightsCpu <= ramBudget) return r;
  }
  return null;
}

function q4ish(m) {
  const qs = Object.keys(m.quants).filter(q => /^(Q4|UD-Q4|IQ4)/.test(q));
  return qs.length ? qs : Object.keys(m.quants);
}

function pickQuant(cfg, m, ctx, kvType, specMult, pessimistic, ov) {
  let best = null, bestQ = null;
  for (const q of q4ish(m)) {
    const r = bestConfig(cfg, m, q, ctx, kvType, specMult, pessimistic, ov);
    if (r && (!best || r.tps > best.tps)) { best = r; bestQ = q; }
  }
  return bestQ || q4ish(m).sort((a, b) => m.quants[a].bytes - m.quants[b].bytes)[0];
}

if (typeof module !== "undefined") module.exports = { kvBytes, weightSplit, evaluate, bestConfig, pickQuant, q4ish, GIB };
