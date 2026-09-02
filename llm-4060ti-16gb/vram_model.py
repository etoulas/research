#!/usr/bin/env python3
"""
Sizing and throughput model for running the seven candidate LLMs on an
RTX 4060 Ti 16 GB + 48 GB DDR4-3200 (i5-6600K), under llama.cpp.

No dependencies. See README.md for the reasoning and models.json for the data.

    python3 vram_model.py --selftest    # check the KV model against published numbers
    python3 vram_model.py --table       # ranked comparison at 32k and 64k
    python3 vram_model.py --detail glm47-flash --ctx 65536
    python3 vram_model.py --calibrate bench.csv
"""

import argparse, json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
GIB = 1024 ** 3

# bytes per element for a llama.cpp KV cache type
KV_TYPE_BYTES = {"f16": 2.0, "q8_0": 1.0625, "q5_1": 0.75, "q4_0": 0.5625}


def load(path=None):
    with open(path or os.path.join(HERE, "models.json")) as f:
        return json.load(f)


# ---------------------------------------------------------------- KV cache

def kv_bytes(model, ctx, kv_type="f16", pessimistic_glm=False):
    """Total KV/state bytes at a given context.

    Handled per layer *group*, because none of these models is uniform:
      attention_full  grows linearly with ctx
      attention_swa   saturates at the sliding window
      attention_mla   one latent cache (not separate K and V)
      linear_state    constant, independent of ctx (Mamba-2 / GatedDeltaNet)
    """
    e = KV_TYPE_BYTES[kv_type]
    groups = model["layer_groups"]
    if pessimistic_glm and "layer_groups_alt_mha" in model:
        groups = model["layer_groups_alt_mha"]

    total = 0.0
    for g in groups:
        n = g["count"]
        t = g["type"]
        if t == "attention_full":
            per_tok = 2 * g["n_kv_heads"] * g["head_dim"] * e
            per_tok *= g.get("kv_share_factor", 1.0)
            total += n * per_tok * ctx
        elif t == "attention_swa":
            eff = min(ctx, g["window"])
            total += n * 2 * g["n_kv_heads"] * g["head_dim"] * e * eff
        elif t == "attention_mla":
            # single compressed latent per token per layer
            total += n * (g["kv_lora_rank"] + g["qk_rope_head_dim"]) * e * ctx
        elif t == "linear_state":
            total += n * g["state_bytes_per_layer"]   # constant in ctx
        else:
            raise ValueError("unknown layer group type: " + t)
    return total


def kv_bytes_read_per_token(model, ctx, kv_type="f16", pessimistic_glm=False):
    """Bytes of cache actually *read* during one decode step.

    Full-attention layers read the whole cache; SWA layers read only their
    window; recurrent-state layers read their fixed state.
    """
    return kv_bytes(model, ctx, kv_type, pessimistic_glm)


# ------------------------------------------------------- weights and split

def weight_split(model, quant):
    """(non_expert_bytes, expert_total_bytes, expert_active_bytes) at this quant.

    For MoE the identity in models.json._about is exact given P_total, P_active,
    k and n, so the per-token byte counts do not depend on guessing where the
    tensors physically live.
    """
    file_bytes = model["quants"][quant]["bytes"]
    p_tot = model["params_total"]
    bpp = file_bytes / p_tot                      # bytes per parameter, from the real file size

    if model["kind"] == "dense":
        return file_bytes, 0.0, 0.0

    k, n = model["n_experts_active"], model["n_experts"]
    frac = k / n
    expert_params = (p_tot - model["params_active"]) / (1.0 - frac)
    non_expert_params = p_tot - expert_params
    return non_expert_params * bpp, expert_params * bpp, expert_params * frac * bpp


# ------------------------------------------------------------- one config

def evaluate(cfg, model, quant, ctx, kv_type="f16", cpu_moe_frac=0.0,
             spec_mult=1.0, pessimistic_glm=False, eff_gpu=None, eff_cpu=None):
    """Size and speed one (model, quant, ctx, offload) point.

    cpu_moe_frac is the fraction of *expert* weight bytes kept in system RAM
    (what -ncmoe / --n-cpu-moe buys you). For dense models it instead moves
    whole layers, which is far more expensive per byte -- modelled the same way
    but flagged, because for a dense model every offloaded byte is read every
    single token.
    """
    hw, d = cfg["hardware"], cfg["defaults"]
    eff_gpu = eff_gpu if eff_gpu is not None else d["eff_gpu"]
    eff_cpu = eff_cpu if eff_cpu is not None else d["eff_cpu"]
    bw_gpu = hw["gpu"]["bandwidth_bytes_per_s"] * eff_gpu
    # The CPU path is the slower of two ceilings: DRAM bandwidth, and how fast the
    # cores can actually dequantise and multiply. On 4 AVX2 Skylake cores the second
    # ceiling binds hard -- see models.json defaults.cpu_thread_note.
    bw_cpu = min(hw["cpu"]["ram_bandwidth_bytes_per_s"] * eff_cpu,
                 hw["cpu"]["threads"] * d["cpu_bytes_per_s_per_thread"])

    non_exp, exp_tot, exp_act = weight_split(model, quant)
    dense = model["kind"] == "dense"

    if dense:
        # cpu_moe_frac reinterpreted as "fraction of all weights on CPU"
        w_cpu = non_exp * cpu_moe_frac
        w_gpu = non_exp - w_cpu
        read_gpu, read_cpu = w_gpu, w_cpu          # dense: every byte, every token
    else:
        exp_cpu = exp_tot * cpu_moe_frac
        w_gpu = non_exp + (exp_tot - exp_cpu)
        w_cpu = exp_cpu
        read_gpu = non_exp + exp_act * (1.0 - cpu_moe_frac)
        read_cpu = exp_act * cpu_moe_frac

    kv = kv_bytes(model, ctx, kv_type, pessimistic_glm)
    kv_read = kv_bytes_read_per_token(model, ctx, kv_type, pessimistic_glm)

    vram_used = w_gpu + kv + d["compute_buffer_bytes"] + d["cuda_ctx_bytes"]
    vram_budget = hw["gpu"]["vram_usable_bytes"]

    overhead = d["overhead_s_per_token_hybrid"] if w_cpu > 0 else d["overhead_s_per_token_gpu_only"]
    t_tok = read_gpu / bw_gpu + read_cpu / bw_cpu + kv_read / bw_gpu + overhead
    tps = spec_mult / t_tok

    return {
        "fits": vram_used <= vram_budget,
        "vram_used": vram_used, "vram_budget": vram_budget,
        "weights_gpu": w_gpu, "weights_cpu": w_cpu, "kv": kv,
        "read_gpu": read_gpu, "read_cpu": read_cpu,
        "ram_used": w_cpu,
        "cpu_moe_frac": cpu_moe_frac, "tps": tps,
        "t_gpu_ms": 1000 * read_gpu / bw_gpu, "t_cpu_ms": 1000 * read_cpu / bw_cpu,
        "t_kv_ms": 1000 * kv_read / bw_gpu, "t_ovh_ms": 1000 * overhead,
        "dense_offload": dense and cpu_moe_frac > 0,
    }


def best_config(cfg, model, quant, ctx, kv_type="f16", spec_mult=1.0,
                pessimistic_glm=False, steps=201):
    """Smallest offload fraction that fits => fastest config that fits.

    Throughput falls monotonically with offload, so the optimum is always the
    least offload that still fits in VRAM.
    """
    ram_budget = cfg["hardware"]["cpu"]["ram_bytes"] * 0.75   # leave room for the OS and page cache
    for i in range(steps):
        frac = i / (steps - 1)
        r = evaluate(cfg, model, quant, ctx, kv_type, frac, spec_mult, pessimistic_glm)
        if r["fits"] and r["ram_used"] <= ram_budget:
            return r
    return None


def max_context(cfg, model, quant, kv_type, target_tps, spec_mult=1.0,
                pessimistic_glm=False, lo=4096, hi=262144):
    """Largest context (rounded to 4k) that still fits and clears target_tps."""
    def ok(c):
        r = best_config(cfg, model, quant, c, kv_type, spec_mult, pessimistic_glm)
        return r is not None and r["tps"] >= target_tps
    if not ok(lo):
        return 0
    hi = min(hi, model["ctx_native"])
    while hi - lo > 4096:
        mid = (lo + hi) // 2 // 4096 * 4096
        if ok(mid):
            lo = mid
        else:
            hi = mid
    return lo


# ---------------------------------------------------------------- selftest

def selftest(cfg):
    """Check the KV model against numbers published for these models.

    These are predictions, not fits: the layer configuration comes from the
    architecture description, and the published byte count is only used to
    check it.
    """
    ok = True
    by_id = {m["id"]: m for m in cfg["models"]}

    for mid in ("muse-glimmer-30b", "gemma4-31b"):
        m = by_id[mid]
        cal = m["kv_calibration"]
        got = kv_bytes(m, cal["ctx"], "f16")
        exp = cal["reported_bytes"]
        err = abs(got - exp) / exp
        status = "PASS" if err < 0.15 else "FAIL"
        ok &= err < 0.15
        print(f"[{status}] {m['name']:<24} KV @ {cal['ctx']:>7,} ctx: "
              f"model {got/GIB:6.2f} GiB vs reported {exp/GIB:6.2f} GiB  ({err*100:4.1f}% off)")

    # bits/param sanity on every quant we carry
    print()
    for m in cfg["models"]:
        for q, v in m["quants"].items():
            bits = v["bytes"] / m["params_total"] * 8
            flag = ""
            if q.startswith(("Q4", "UD-Q4", "IQ4")) and not (4.2 <= bits <= 5.6):
                flag = "  <== not Q4-shaped"
                if v.get("confidence") != "unverified":
                    ok = False
                    flag += " (and not flagged!)"
            print(f"       {m['name']:<24} {q:<12} {v['bytes']/1e9:5.1f} GB = {bits:4.2f} bits/param{flag}")

    # the expert-split identity must reproduce active params exactly
    print()
    for m in cfg["models"]:
        if m["kind"] != "moe":
            continue
        q = list(m["quants"])[0]
        non_exp, exp_tot, exp_act = weight_split(m, q)
        bpp = m["quants"][q]["bytes"] / m["params_total"]
        recon = (non_exp + exp_act) / bpp
        err = abs(recon - m["params_active"]) / m["params_active"]
        status = "PASS" if err < 1e-6 else "FAIL"
        ok &= err < 1e-6
        print(f"[{status}] {m['name']:<24} expert split reconstructs "
              f"{recon/1e9:4.2f}B active (declared {m['params_active']/1e9:.2f}B)")

    print("\n" + ("ALL CHECKS PASSED" if ok else "SOME CHECKS FAILED"))
    return 0 if ok else 1


# ------------------------------------------------------------------ report

def q4ish(m):
    """The Q4/IQ4-class quants we are allowed to consider."""
    qs = [q for q in m["quants"] if q.startswith(("Q4", "UD-Q4", "IQ4"))]
    return qs or list(m["quants"])


def pick_quant(cfg, m, ctx, kv_type, spec_mult=1.0, pessimistic=False):
    """Best Q4-class quant for this model at this context.

    A smaller quant is not automatically better: it frees VRAM, which cuts the
    offload fraction, which is worth far more than the extra bytes cost. But a
    quant small enough to fit entirely wins outright. So just try them all.
    """
    best, bestq = None, None
    for q in q4ish(m):
        r = best_config(cfg, m, q, ctx, kv_type, spec_mult, pessimistic)
        if r and (best is None or r["tps"] > best["tps"]):
            best, bestq = r, q
    if bestq is None:                     # nothing fits; report the largest-context failure
        bestq = sorted(q4ish(m), key=lambda q: m["quants"][q]["bytes"])[0]
    return bestq


def table(cfg, kv_type="q8_0", target=10.0, use_spec=False):
    rows = []
    for m in cfg["models"]:
        spec = cfg["defaults"]["mtp_speedup"] if (use_spec and m.get("mtp")) else 1.0
        q = pick_quant(cfg, m, 32768, kv_type, spec, m["id"] == "glm47-flash" and False)
        pess = m["id"] == "glm47-flash"
        row = {"m": m, "q": q, "spec": spec}
        for ctx in (32768, 65536):
            row[ctx] = best_config(cfg, m, q, ctx, kv_type, spec)
        row["maxctx"] = max_context(cfg, m, q, kv_type, target, spec)
        row["pess32k"] = best_config(cfg, m, q, 32768, kv_type, spec, True) if pess else None
        rows.append(row)

    rows.sort(key=lambda r: -(r[32768]["tps"] if r[32768] else 0))

    mtp = cfg["defaults"]["mtp_speedup"]
    print(f"\nRTX 4060 Ti 16 GB + 48 GB DDR4-3200 | KV cache = {kv_type} | target > {target:.0f} tok/s")
    print("Baseline assumes NO speculative decoding. 'MTP?' is the upside IF llama.cpp")
    print(f"implements self-speculation for that architecture ({mtp}x) -- verify, do not assume.\n")
    hdr = (f"{'model':<25}{'quant':<12}{'32k t/s':>9}{'off':>6}{'64k t/s':>9}{'off':>6}"
           f"{'MTP? 32k':>10}{'max ctx':>9}")
    print(hdr); print("-" * len(hdr))
    for r in rows:
        def cell(x):
            if x is None:
                return f"{'--':>9}{'--':>6}"
            return f"{x['tps']:>9.1f}{x['cpu_moe_frac']*100:>5.0f}%"
        mc = r["maxctx"]
        mcs = f"{mc//1024}k" if mc else "none"
        up = f"{r[32768]['tps']*mtp:>10.1f}" if (r[32768] and r["m"].get("mtp")) else f"{'-':>10}"
        print(f"{r['m']['name'][:24]:<25}{r['q']:<12}{cell(r[32768])}{cell(r[65536])}{up}{mcs:>9}")
    print()
    for r in rows:
        if r["pess32k"]:
            p = r["pess32k"]
            print(f"note: {r['m']['name']} under the pessimistic MHA reading of its attention: "
                  f"{'fits, ' + format(p['tps'], '.1f') + ' tok/s' if p else 'DOES NOT FIT at 32k'}")
    return rows


def detail(cfg, mid, quant, ctx, kv_type, spec, pess):
    m = next(x for x in cfg["models"] if x["id"] == mid)
    quant = quant or pick_quant(cfg, m, ctx, kv_type, 1.0, pess)
    spec = spec if spec is not None else (1.6 if m.get("mtp") else 1.0)
    r = best_config(cfg, m, quant, ctx, kv_type, spec, pess)
    print(f"\n{m['name']}  [{quant}]  ctx={ctx:,}  kv={kv_type}  spec x{spec}")
    print("-" * 62)
    if r is None:
        print("does not fit in 15 GiB VRAM + 36 GB RAM at any offload level")
        return
    print(f"  weights on GPU     {r['weights_gpu']/GIB:8.2f} GiB")
    print(f"  weights in RAM     {r['weights_cpu']/GIB:8.2f} GiB   ({r['cpu_moe_frac']*100:.0f}% of expert bytes)")
    print(f"  KV cache           {r['kv']/GIB:8.2f} GiB")
    print(f"  compute + ctx      {(cfg['defaults']['compute_buffer_bytes']+cfg['defaults']['cuda_ctx_bytes'])/GIB:8.2f} GiB")
    print(f"  ---------------------------------")
    print(f"  VRAM total         {r['vram_used']/GIB:8.2f} GiB  of {r['vram_budget']/GIB:.2f} GiB")
    print()
    print(f"  bytes read / token: GPU {r['read_gpu']/1e6:7.1f} MB   RAM {r['read_cpu']/1e6:7.1f} MB")
    print(f"  time  / token:  GPU {r['t_gpu_ms']:5.2f} ms | RAM {r['t_cpu_ms']:5.2f} ms | "
          f"KV {r['t_kv_ms']:5.2f} ms | overhead {r['t_ovh_ms']:4.2f} ms")
    nml = m.get("n_moe_layers", m["n_layers"])
    nc = round(r["cpu_moe_frac"] * nml)
    print(f"  => {r['tps']:.1f} tok/s")
    print(f"  flag: {'-ncmoe ' + str(nc) if nc else '(no offload needed)'}"
          f"{'   [of ' + str(nml) + ' MoE layers]' if m['kind'] == 'moe' else '   [dense: use -ngl instead]'}")


def calibrate(cfg, csvpath):
    """Fit eff_gpu / eff_cpu to measured bench.sh output.

    CSV columns: model_id,quant,ctx,kv_type,cpu_moe_frac,tok_per_s
    """
    import csv as _csv
    rows = list(_csv.DictReader(open(csvpath)))
    if not rows:
        print("no rows in " + csvpath); return
    by_id = {m["id"]: m for m in cfg["models"]}
    best, bestval = None, 1e18
    for eg in [x / 100 for x in range(50, 96, 2)]:
        for ec in [x / 100 for x in range(30, 86, 2)]:
            err = 0.0
            for row in rows:
                m = by_id.get(row["model_id"])
                if not m:
                    continue
                r = evaluate(cfg, m, row["quant"], int(row["ctx"]), row["kv_type"],
                             float(row["cpu_moe_frac"]), 1.0, False, eg, ec)
                err += (math.log(r["tps"]) - math.log(float(row["tok_per_s"]))) ** 2
            if err < bestval:
                bestval, best = err, (eg, ec)
    eg, ec = best
    print(f"best fit over {len(rows)} measurements: eff_gpu={eg:.2f} eff_cpu={ec:.2f} "
          f"(rms log-error {math.sqrt(bestval/len(rows)):.3f})")
    print(f"put these into models.json -> defaults to make every prediction match your machine")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--table", action="store_true")
    ap.add_argument("--detail")
    ap.add_argument("--calibrate")
    ap.add_argument("--quant")
    ap.add_argument("--ctx", type=int, default=32768)
    ap.add_argument("--kv", default="q8_0", choices=list(KV_TYPE_BYTES))
    ap.add_argument("--spec", type=float)
    ap.add_argument("--pessimistic", action="store_true")
    ap.add_argument("--target", type=float, default=10.0)
    a = ap.parse_args()
    cfg = load()

    if a.selftest:
        sys.exit(selftest(cfg))
    if a.calibrate:
        calibrate(cfg, a.calibrate); return
    if a.detail:
        detail(cfg, a.detail, a.quant, a.ctx, a.kv, a.spec, a.pessimistic); return
    table(cfg, a.kv, a.target)


if __name__ == "__main__":
    main()
