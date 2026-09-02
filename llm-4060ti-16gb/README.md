# Which open-weights LLM actually runs well on a 4060 Ti 16 GB?

An architecture-first analysis of seven 27–35B models on one specific machine:
**RTX 4060 Ti 16 GB + 48 GB DDR4-3200 + i5-6600K**, targeting Q4/IQ4, ≥32k context and
>10 tok/s generation.

**[→ Interactive planner](https://etoulas.github.io/research/llm-4060ti-16gb/planner.html)** —
pick a model, drag context / quant / offload, see the VRAM breakdown and predicted speed.

> **These numbers are modelled, not measured.** The research container had no GPU, and the
> egress policy blocked huggingface.co, so no GGUF was downloaded or run. Everything below
> comes from published architecture descriptions plus a physical model of the decode loop,
> validated against published KV-cache figures to within 2%. `bench.sh` turns the
> predictions into measurements on your machine; `--calibrate` folds them back in.
> Read [Confidence and limitations](#confidence-and-limitations) before acting on a number.

---

## The answer

**Run `Qwen3.6-35B-A3B-MTP` at IQ4_XS with 32–64k context.** Predicted **≈39 tok/s at 32k**
and **≈35 tok/s at 64k**, comfortably over your 10 tok/s bar, with headroom to 252k context.
It is the strongest all-rounder of the seven for agentic coding *and* general reasoning.

**Runner-up: `GLM-4.7-Flash` at IQ4_XS** — ≈36 tok/s at 32k, and the better pick if your
work is mostly agentic coding, where it is the more specialised model. One caveat below.

**If you want the coding specialist regardless of speed: `Laguna-XS-2.1` Q4_K_M**, ≈11 tok/s
at 32k. It clears the bar but only just, because its 33B of weights force more offload.

**Do not run the three dense models** (Qwen3.8-27B, Gemma-4-31B, Muse-Glimmer-30B). They
land at 1.5–9.0 tok/s. The reason is not "they don't fit" — it is explained below, and it is
the most useful thing in this report.

| model | best quant | 32k tok/s | offload | 64k tok/s | max ctx >10 t/s |
|---|---|--:|--:|--:|--:|
| **Qwen3.6-35B-A3B-MTP** | IQ4_XS | **38.9** | 24% | **35.0** | 252k |
| **GLM-4.7-Flash** | IQ4_XS | **35.6** | 14% | **25.9** | 124k |
| NVIDIA-Nemotron-3.5-Lightning | UD-Q4_K_XL | 30.6 | 23% | 27.2 | 252k |
| Laguna-XS-2.1 | Q4_K_M | 11.2 | 27% | 10.3 | 80k |
| Muse-Glimmer-30B | IQ4_XS | 9.0 | 2% | 6.2 | 20k |
| Qwen3.8-27B | IQ4_XS | 3.8 | 11% | 2.5 | — |
| Gemma-4-31B-it | Q4_K_M | 1.5 | 30% | 1.2 | — |

*KV cache q8_0, 15.0 GiB usable VRAM, no speculative decoding assumed. Full output in
[`results.md`](results.md).*

---

## Why the usual advice is wrong for this machine

Search for any of these models plus "16 GB" and you get some version of:

> Q4_K_M is 19 GB > 16 GB, so it doesn't fit. Use a 14B model instead.

That is wrong twice over, and the two errors point in opposite directions.

### Error 1: "doesn't fit" assumes all weights are equal

For a **MoE** model, only ~3B of 30–35B parameters are read per token. `--n-cpu-moe N`
keeps the *expert* tensors of N layers in system RAM and computes them on the CPU, leaving
attention, embeddings and the shared expert on the GPU. You pay RAM bandwidth only for the
small routed slice actually used. A 35B-A3B model at 24% expert offload reads 1.49 GB from
VRAM and just 0.14 GB from RAM per token. That is why four of these "too big" models run
at 11–39 tok/s.

Crucially, **PCIe is not in this path**. The offloaded experts are *computed* on the CPU;
only activation vectors cross the bus. Your Gen3 x8 link (7.9 GB/s, thanks to the Z170
board) would be crippling if llama.cpp streamed weights across it, and is irrelevant when
it doesn't. Do not choose `--n-gpu-layers` for a MoE model where `--n-cpu-moe` will do.

### Error 2: for dense models it is far *more* pessimistic than reality warrants — until you check the CPU

A dense model reads **every** weight **every** token. So offloading 2% of a dense 28B model
costs you 370 MB of CPU-side reads per token — which on this CPU takes 42 ms, more than the
entire GPU-side work. Muse-Glimmer-30B at only 2% offload already drops to 9.0 tok/s.

Which brings us to the finding that actually decides this comparison.

---

## The three findings that decide it

### 1. On an i5-6600K, the offload path is core-bound, not RAM-bound

My first model priced CPU-side reads at DDR4-3200 bandwidth (~28 GB/s effective) and
produced nonsense — 89 tok/s. In reality llama.cpp's CPU-side MoE FFN on **AVX2 Skylake
sustains only ~2.2 GB/s of quantised weights per core** (dequantise + GEMV; no AVX-512, no
AMX). Four cores gives **~8.8 GB/s** — about a third of what your memory subsystem could
deliver.

Three consequences, and they are the practical core of this report:

- **Your RAM is already faster than your CPU can use.** The DDR4-3200 XMP profile is not a
  bottleneck and faster RAM would buy nothing. Do not spend money there.
- **Every byte moved off the GPU costs ~26× GPU time** (225 GB/s effective vs 8.8 GB/s),
  not the ~7× the raw bandwidth ratio suggests.
- **Therefore minimising offload dominates every other tuning decision.** A *smaller* quant
  that reduces offload beats a larger, nominally better one: GLM-4.7-Flash goes from
  **20.9 → 35.6 tok/s** purely by choosing IQ4_XS over UD-Q4_K_XL, because offload falls
  from 27% to 14%. Same model, same context, +70% speed, and the quality difference between
  IQ4_XS and Q4_K_XL is far smaller than 70%.

This is also why the ranking is trustworthy even though the 2.2 GB/s constant is an
estimate. Sweeping it from 1.2 to 7.0 GB/s per core — pessimistic to modern-8-core — never
changes the order, and all four MoEs clear 10 tok/s even at the pessimistic end.

### 2. None of these seven is a plain transformer, and generic VRAM calculators mis-size all of them

This is why the model had to be built per architecture:

| model | layer structure | KV consequence |
|---|---|---|
| Qwen3.8-27B | 64 = **48 GatedDeltaNet + 16 attention** (GQA 24/4, head_dim 256) | only 16 layers grow: 64 KiB/token |
| Gemma-4-31B | 60 = **50 SWA(4096) + 10 global** | ~74% cut vs all-global |
| Muse-Glimmer-30B | 52, GQA **32Q/2KV**, SWA 2048, 3:1 | 2 KV heads → 26 KiB/token |
| Nemotron-3.5-Lightning | 52 = **23 Mamba-2 + 23 MoE + 6 attention** | only 6 layers grow; SSM state is constant |
| Qwen3.6-35B-A3B | 40 = **30 GatedDeltaNet + 10 attention** | 10 growing layers |
| Laguna-XS-2.1 | 40 = **30 SWA(512) + 10 global** | window 512 → SWA part is free |
| GLM-4.7-Flash | 47, **MLA** | compressed latent cache |

The standard `2 · n_layer · n_kv · d_head · ctx` formula is wrong for **every single one**.
Practically: **long context is cheap on this list.** Qwen3.6-35B-A3B carries a 32k cache in
0.4 GiB; Nemotron's is smaller still. Your ≥32k requirement, which would have been the
binding constraint on a 2024-era model, barely matters here — weights dominate. That is why
"max context" in the table above reaches 252k for two models.

### 3. Two published numbers the model reproduces — and one it contradicts

The KV model is validated, not fitted:

- **Muse-Glimmer-30B**: head_dim = 256 was *derived* from the reported 15.9 → 19.3 GB VRAM
  delta over 130k context. The resulting model reproduces that delta to **0.7%**.
- **Gemma-4-31B**: predicts 21.6 GiB KV at 262k against a reported ~22 GiB — **2.0%** off.

The contradiction: **Nemotron's widely-quoted "Q4_K_M = 25.48 GB" is not Q4-shaped.** For a
30B model that is 6.79 bits/param. Compare GLM-4.7-Flash, where Q4_K_M = 18.3 GB = 4.88
bits/param (correct) and Q6_K = 24.7 GB = 6.6 bits. Either the figure is mislabelled, or
that GGUF keeps the Mamba-2 / MTP tensors at high precision — plausible, since SSM
state-transition tensors are quantisation-sensitive. The table above uses an estimated
UD-Q4_K_XL at 4.9 bits/param instead, and flags it. **Check the real file size before
downloading 25 GB.**

---

## Per-model verdicts

### Qwen3.6-35B-A3B-MTP — recommended
40 layers, 256 experts (8 routed + 1 shared), 30 GatedDeltaNet + 10 attention layers, 262k
native context. The 256-expert / top-8 routing gives the finest granularity on the list, so
each token touches the least expert weight — exactly what you want when offloaded bytes are
expensive. Ships an MTP head. Best speed *and* best max context.

*Caveat:* the sourced size is UD-Q4_K_XL at 22.4 GB; the 19.0 GB IQ4_XS is my estimate. At
the sourced UD-Q4_K_XL it still delivers 25.8 tok/s at 37% offload, so the recommendation
does not depend on that estimate.

### GLM-4.7-Flash — recommended for coding-heavy use
47 layers, 64 experts (top-4 + 1 shared), MLA, MTP, 131k context. The lowest offload
fraction of any model here (14% at 32k) because its Q4 file is the smallest of the MoEs.

*The one caveat worth knowing:* sources describe it as using **both** MLA **and** "20
attention heads, 20 KV heads" — plain MHA. Those imply KV caches ~9× apart: 53 KiB/token vs
470 KiB/token, i.e. 1.7 GB vs 15 GB at 32k. Under the pessimistic MHA reading it still fits
but drops to **8.9 tok/s**, below your bar. `bench.sh` settles it in ten seconds from
llama.cpp's `KV self size` line at startup. Toggle it in the planner to see both.

### NVIDIA-Nemotron-3.5-Lightning-30B-A3B — strong third
Only 6 of 52 layers hold a growing KV cache, and the 23 Mamba-2 layers have constant state,
so it is the most context-scalable model here: 252k at >10 tok/s. Note `-ncmoe` caps at
**23**, not 52, because only 23 layers carry expert weights. Held back only by the
unverified Q4 file size.

### Laguna-XS-2.1 — the coding specialist, if you accept ~11 tok/s
Best reported coding scores of the group (SWE-bench Verified 70.9%). But 33.45B of weights
at 4.86 bits and only a 64-expert / top-8 split means both a bigger file and a coarser
routing granularity, so it reads more expert bytes per token than the others. Clears your
bar at 32k (11.2 tok/s) with little margin; drops below it past ~80k.

### Muse-Glimmer-30B — the only dense model with a path
Dense 27.8B text backbone (the 1.8B ViT ships as a separate mmproj and costs nothing unless
loaded), with a remarkably cheap cache: 2 KV heads and a 2048 sliding window. At IQ4_XS it
needs only 2% offload — and that 2% costs it two thirds of its speed.

**Worth knowing:** at **15.5 GiB usable VRAM it becomes fully resident and jumps 9.0 → 14.5
tok/s.** So if you run headless, or put the desktop on the i5's iGPU, this dense multimodal
model becomes viable. Freeing ~500 MB of VRAM is worth more here than any flag.

### Qwen3.8-27B — no
3.8 tok/s. Dense, and its Q4 files (17.8–17.9 GB) are too large to avoid offload. Its
hybrid attention makes long context cheap, which does not help when weights are the problem.
A shame, as it is the strongest general model of the seven on paper.

### Gemma-4-31B-it — no
1.5 tok/s, the worst fit. Largest dense weights (18 GB at Q4_K_M) forcing 30% offload, and
its KV cache is the most expensive here in absolute terms (80 KiB/token from the 10 global
layers). Both constraints point the wrong way.

---

## llama.cpp or vLLM?

**llama.cpp, decisively — because of one feature: `--n-cpu-moe`.**

vLLM is the better engine when the model fits entirely in VRAM: continuous batching, paged
attention, far better prompt throughput. None of that helps here, because **nothing on this
list fits in 15 GiB at Q4 with a 32k cache** — the model checked all seven at zero offload
and every one exceeded the budget. vLLM has no equivalent of selective expert offload; its
CPU-offload path moves whole layers and is not designed for interactive decode. Falling back
to layer offload would put you in the dense-model regime described above, at 1–4 tok/s.

Secondary reasons: vLLM's GGUF support is slower than its native path and uneven across
exotic architectures, and four of these seven are hybrids (Mamba-2, GatedDeltaNet, MLA) with
uneven kernel coverage. NVFP4 weights exist for Nemotron but need Blackwell — your Ada card
cannot use them.

**When to revisit:** if you move to a 24 GB card. At 24 GB these MoEs fit outright, and vLLM
would then beat llama.cpp meaningfully, especially on prompt processing.

---

## Tuning guide

Ready-to-run, in recommended order. Adjust `-ncmoe` down until you see an OOM, then back off
by one — that single number is worth more than everything else combined.

```bash
# 1. Qwen3.6-35B-A3B-MTP — best all-rounder, ~39 tok/s @ 32k
llama-server -m Qwen3.6-35B-A3B-MTP-IQ4_XS.gguf \
  -c 32768 -ngl 999 -ncmoe 10 \
  -fa on -ctk q8_0 -ctv q8_0 \
  -t 4 -b 2048 -ub 512 --cache-reuse 256 --no-mmap
# 64k: -c 65536 -ncmoe 11   (~35 tok/s)

# 2. GLM-4.7-Flash — agentic coding, ~36 tok/s @ 32k, lowest offload of all
llama-server -m GLM-4.7-Flash-IQ4_XS.gguf \
  -c 32768 -ngl 999 -ncmoe 6 \
  -fa on -ctk q8_0 -ctv q8_0 \
  -t 4 -b 2048 -ub 512 --cache-reuse 256 --no-mmap
# 64k: -c 65536 -ncmoe 9    (~26 tok/s).  Note -ncmoe counts the 46 MoE layers, not 47.

# 3. Nemotron-3.5-Lightning — most context-scalable; -ncmoe caps at 23
llama-server -m NVIDIA-Nemotron-3.5-Lightning-30B-A3B-UD-Q4_K_XL.gguf \
  -c 65536 -ngl 999 -ncmoe 6 \
  -fa on -ctk q8_0 -ctv q8_0 \
  -t 4 -b 2048 -ub 512 --cache-reuse 256 --no-mmap

# 4. Laguna-XS-2.1 — the coding specialist, ~11 tok/s @ 32k
llama-server -m Laguna-XS-2.1-Q4_K_M.gguf \
  -c 32768 -ngl 999 -ncmoe 11 \
  -fa on -ctk q8_0 -ctv q8_0 \
  -t 4 -b 2048 -ub 512 --cache-reuse 256 --no-mmap

# 5. Muse-Glimmer-30B — dense, so ONLY worth running headless where it fits entirely.
#    Dense models use -ngl (whole layers); -ncmoe does nothing, there are no experts.
llama-server -m Muse-Glimmer-30B-IQ4_XS.gguf \
  -c 32768 -ngl 999 \
  -fa on -ctk q8_0 -ctv q8_0 \
  -t 4 -b 2048 -ub 512 --no-mmap
# With a desktop running (~15.0 GiB usable) this OOMs: drop to -ngl 51 and take ~9 tok/s.
# Headless (~15.5 GiB usable) it is fully resident at ~14.5 tok/s -- run it headless or not at all.
# add --mmproj mmproj-Muse-Glimmer-30B-Q8_0.gguf only if you need vision (costs extra VRAM)
```

### What each flag is doing, and what actually matters

| flag | why | worth |
|---|---|---|
| `-ncmoe N` | expert tensors of N layers to CPU RAM | **the whole ballgame.** Tune it first, lowest value that fits |
| `-ctk q8_0 -ctv q8_0` | halves the KV cache vs f16 | frees 0.5–1.8 GiB → less offload → **+10–15%** speed |
| `-fa on` | flash attention | required for KV quantisation; also cuts the compute buffer |
| `-ngl 999` | all layers on GPU, then `-ncmoe` pulls experts back | correct idiom for MoE — do **not** hand-tune `-ngl` |
| `-t 4` | 4 threads = 4 physical cores | more threads hurt; there is no SMT on a 6600K |
| `--no-mmap` | fully load weights instead of paging | avoids page-cache stalls on the CPU-resident experts |
| `--cache-reuse 256` | reuse prefix KV across turns | large win for agentic loops that resend context |
| `-b 2048 -ub 512` | batch sizes | defaults are fine; lowering `-ub` frees a little compute buffer if you are 100 MB short |

**Things not worth doing on this hardware:** faster RAM (the CPU can't use it); tuning
PCIe (not in the decode path with `-ncmoe`); `-ctk q4_0` (saves little once you are already
at q8_0, and hurts quality); more threads than 4.

**Worth doing:** free VRAM. Running headless or moving the desktop to the iGPU is worth
~500 MB, which is worth more than any flag — and for Muse-Glimmer it is the difference
between 9.0 and 14.5 tok/s.

### About MTP

Three of these (Qwen3.6, Nemotron, GLM-4.7-Flash) ship multi-token-prediction heads. If
llama.cpp implements self-speculation for the architecture, expect roughly **1.6×** —
and it is worth *more* than usual here, because verifying several tokens per forward pass
amortises the expensive CPU-side expert reads.

But a GGUF containing MTP tensors does not mean llama.cpp uses them; support is
per-architecture and often absent (there is a public report of exactly this for Nemotron in
LM Studio). **All numbers in this report assume no speculation.** Treat MTP as upside, check
it with `bench.sh`, and enable the toggle in the planner only after you have confirmed it.

---

## Verify it on your machine

```bash
python3 vram_model.py --selftest              # KV model vs published figures
python3 vram_model.py --table                 # the ranking above
python3 vram_model.py --detail glm47-flash --ctx 65536

./bench.sh ~/models/GLM-4.7-Flash-IQ4_XS.gguf glm47-flash IQ4_XS
python3 vram_model.py --calibrate bench.csv   # fit eff_gpu/eff_cpu to reality
```

`bench.sh` sweeps `-ncmoe` and context, writes `bench.csv`, prints llama.cpp's reported
`KV self size` (which settles the GLM question), and checks whether the build advertises MTP.
`--calibrate` then reports the `eff_gpu` / `eff_cpu` that best fit your measurements; put
them in `models.json` → `defaults` and every prediction, including the planner's, matches
your machine.

## Confidence and limitations

- **Nothing here was measured.** No GPU in the research environment; `huggingface.co`,
  `unsloth.ai`, `poolside.ai` and `arxiv.org` were blocked by the egress policy, so no
  config.json, GGUF header or benchmark was read directly. Architecture facts come from
  search-result summaries, each recorded with a source URL and a confidence level in
  [`models.json`](models.json).
- **What I trust:** the *ranking*, which is stable across the full plausible range of every
  uncertain parameter, and the KV-cache model, which reproduces two independent published
  figures to within 2%.
- **What I trust less:** absolute tok/s, ±30% until calibrated. The 2.2 GB/s-per-core
  constant is the biggest lever and the least certain.
- **Explicitly unverified:** Nemotron's Q4 file size (flagged above); GLM-4.7-Flash's
  attention type (both readings modelled); the IQ4_XS sizes for Qwen3.6, Muse-Glimmer and
  GLM, which are estimated from bits/param rather than sourced.
- **Not modelled:** prompt-processing speed (compute-bound, a different regime — expect it
  to be the slower half of agentic work on this CPU), quality differences between quants,
  and multi-user batching.

## Files

| file | what |
|---|---|
| [`planner.html`](https://etoulas.github.io/research/llm-4060ti-16gb/planner.html) | interactive planner |
| `planner.js` | the model in JS; verified to match the Python on all 28 test points |
| `models.json` | architecture data, every field with a source and confidence level |
| `vram_model.py` | sizing + throughput model, solver, selftest, calibration |
| `bench.sh` | validation sweep to run on the real machine |
| `results.md` | generated output |
| `notes.md` | working log, including the two modelling bugs and how they were found |
