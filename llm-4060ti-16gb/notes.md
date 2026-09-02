# Notes: best open-weights LLM for RTX 4060 Ti 16 GB + 48 GB DDR4-3200 (i5-6600K)

Target: Q4/IQ4 class, >=32k context (64k preferred), >10 tok/s generation.

## 2026-09-02 — environment reconnaissance

- This research container has **no GPU** (`nvidia-smi` not found) and no llama.cpp.
  Everything here is analytical modelling; measurement is delegated to a `bench.sh`
  the user runs on the real machine.
- Egress proxy **blocks `huggingface.co`, `unsloth.ai`, `poolside.ai`** (403 on CONNECT,
  `WebFetch` -> EGRESS_BLOCKED). `WebSearch` works. `WebFetch` works on other domains
  (verified against raw.githubusercontent.com).
  => architecture facts come from WebSearch result summaries + reachable third-party
  pages; anything unsourced is flagged UNVERIFIED in models.json rather than guessed.
- All seven candidate repos confirmed to exist.

## Hardware baseline (the thing that actually decides this)

| Quantity | Value | Note |
|---|---|---|
| GPU | RTX 4060 Ti 16 GB, AD106 | 288 GB/s, 8 GB/s effective PCIe (Gen4 x8 card in a Gen3 slot) |
| VRAM usable for llama.cpp | ~15.0-15.3 GB | desktop/compositor takes 0.5-1.0 GB |
| System RAM | 48 GB DDR4-3200 dual channel | 51.2 GB/s theoretical, ~38-42 GB/s STREAM-realistic |
| CPU | i5-6600K, 4C/4T Skylake, AVX2, no AVX-512 | weak for CPU-side expert GEMM; 4 threads only |
| PCIe | Z170 => Gen3 x16 = 15.75 GB/s | matters only for weight streaming, not for -ot offload |

Key ratio: **GPU memory bandwidth / RAM bandwidth ~= 7x**. Every byte moved from RAM
instead of VRAM costs ~7x the time. That single number drives the whole analysis.

## 2026-09-02 — architecture research

Sources reachable: `WebSearch` (works), `WebFetch` on github.com / raw.githubusercontent.com.
**Blocked by egress policy** (403 CONNECT, reported not worked around): huggingface.co,
unsloth.ai, poolside.ai, arxiv.org, recipes.vllm.ai, kaitchup.substack.com, dev.to,
sebastianraschka.com, glukhov.org, modelscope.cn, hf-mirror.com.
=> no config.json reads, no GGUF header dumps. Architecture facts below come from search
result summaries; each is tagged in models.json with a confidence level.

### Big surprise #1: five of the seven are NOT plain transformers

| Model | Real shape | KV-cache consequence |
|---|---|---|
| Qwen3.8-27B | dense, but 64 layers = **48 GatedDeltaNet + 16 gated attention** (GQA 24/4, head_dim 256) | only 16 layers hold a growing cache -> 64 KiB/token |
| gemma-4-31B | dense, 60 layers = **50 SWA(4096) + 10 global**, global layers share KV | ~74% cut vs all-global |
| Muse-Glimmer-30B | **dense** 29.6B (incl. 1.8B ViT), 52 layers, GQA **32Q/2KV**, SWA 2048, 3:1 | 2 KV heads -> tiny cache |
| Nemotron-3.5-Lightning | MoE, 52 layers = **23 Mamba-2 + 23 MoE + 6 attention** | only 6 layers grow; Mamba state is constant |
| Qwen3.6-35B-A3B | MoE, 40 layers = **30 GatedDeltaNet + 10 attention**, 256 experts top-8+1 | 10 growing layers |
| Laguna-XS-2.1 | MoE 33B-A3B, 40 layers = **30 SWA(512) + 10 global** | window 512 -> SWA part is ~free |
| GLM-4.7-Flash | MoE 30B-A3B, 47 layers, **MLA + MTP**, 64 experts top-4+1 | MLA latent cache, IF llama.cpp uses the MLA path |

So the usual "KV cache = 2*n_layer*n_kv*d_head*ctx" is wrong for **every single one** of them.
A generic VRAM calculator will mis-size all seven. This is the main reason the naive
"30B-A3B Q4 is 19 GB, doesn't fit 16 GB, use a 14B instead" advice found all over the web
is wrong for this hardware.

### Big surprise #2: reported Nemotron Q4_K_M size is not Q4-shaped

Reported Q4_K_M = 25.48 GB for a 30B model = **6.8 bits/param**. Compare GLM-4.7-Flash:
Q4_K_M 18.3 GB / 30B = 4.88 bits/param (correct for Q4_K_M), Q6_K 24.7 GB = 6.6 bits.
So the 25.48 GB figure is either mislabelled, or that GGUF keeps the Mamba-2 / MTP tensors
at high precision (plausible: SSM state-transition tensors are quantisation-sensitive and
llama.cpp keeps several tensor classes at F32/Q8 for hybrid models). Flagged UNVERIFIED;
the planner exposes bits/param so it can be corrected from the real file size.

### Big surprise #3: two clean calibration points fell out of the reported numbers

1. **Muse-Glimmer**: reported ~15.9 GB VRAM at small ctx and 19.3 GB at 130k ctx.
   Delta = 3.4 GB / 130k tokens = 26 KiB/token. Solving
   `2 * 13 global layers * 2 KV heads * head_dim * 2 bytes = 26 KiB` gives **head_dim = 256**,
   which is consistent with hidden 6656 and 32 query heads. The KV model reproduces the
   published number rather than being fitted to it. Used as a selftest.
2. **Gemma-4-31B**: reported ~22 GB KV at 262k. Used as the second selftest.

### The GLM-4.7-Flash contradiction (biggest open question)

Sources say both "multi-head latent attention (MLA)" and "20 attention heads and 20
key-value heads". Those imply wildly different caches:
- MLA latent (kv_lora 512 + rope 64): 47 * 576 * 2 B = **~53 KiB/token** -> 32k = 1.7 GB
- plain MHA 20 KV heads x 128: 2 * 47 * 20 * 128 * 2 B = **~470 KiB/token** -> 32k = 15 GB (!)
A 9x difference that decides whether GLM is the best pick or unusable. models.json carries
both; `bench.sh` resolves it in 10 seconds from llama.cpp's `KV self size` startup line.

## 2026-09-02 — building the model

`vram_model.py` computes KV per *layer group* (full / SWA / MLA / recurrent-state), splits
weights via the exact identity `expert_total = (P_tot - P_act)/(1 - k/n)`, and prices a
decode step as `bytes_gpu/BW_gpu + bytes_cpu/BW_cpu + kv_read/BW_gpu + overhead`.

### Two modelling bugs found by the selftest (both fixed)

1. **Gemma-4-31B was 56% off.** I had applied a `kv_share_factor` of 0.4 for "global layers
   share KV" *on top of* the 50-SWA/10-global split. But the reported "~74% KV reduction"
   IS the sliding-window split — counting both double-counts it. Removed; the model now
   predicts 21.6 GiB vs the reported ~22 GiB at 262k (2.0% off).
2. **Muse-Glimmer bits/param came out at 3.89**, impossible for Q4_K_M. Cause: the GGUF is
   the *text backbone only* — the 1.8B ViT ships as a separate mmproj file. Against the
   27.8B text params it is 4.57 bits/param, which is right. Also means the vision tower is
   not read during text decode, so it costs nothing unless you load mmproj.

The Muse-Glimmer KV check is a genuine prediction, not a fit: head_dim=256 was derived from
the reported 15.9->19.3 GB delta, and the resulting model reproduces that delta to 0.7%.

### Third finding: on THIS CPU the offload path is core-bound, not RAM-bound

First pass used DDR4-3200 bandwidth (~28 GB/s effective) for the CPU side and produced
absurd numbers (89 tok/s). llama.cpp's CPU MoE FFN on AVX2 Skylake sustains only about
**2.2 GB/s of quantised weights per core** (dequantise + GEMV; no AVX-512, no AMX).
Four cores => **~8.8 GB/s**, roughly a third of what the memory subsystem could deliver.

Consequences, and they are the practical heart of this whole report:
- **Faster RAM would not help.** The XMP profile is already ahead of what 4 cores can use.
- Every byte moved off the GPU costs ~26x GPU time (225 GB/s eff. vs 8.8 GB/s eff.),
  not the ~7x the raw bandwidth ratio suggests.
- Therefore **minimising the offloaded fraction dominates every other tuning decision**,
  and a smaller quant that reduces offload beats a larger quant that is nominally better:
  GLM-4.7-Flash goes 20.9 -> 35.6 tok/s purely by choosing IQ4_XS over UD-Q4_K_XL, because
  offload drops 27% -> 14%. Same model, same context, +70% speed.

### Sensitivity: the ranking is robust

Sweeping the per-core figure across 1.2 / 2.2 / 3.5 / 7.0 GB/s (i.e. from "worse than I
think" to "as good as a modern 8-core"), the ordering never changes:
Qwen3.6-35B-A3B > GLM-4.7-Flash > Nemotron-3.5-Lightning > Laguna-XS-2.1 >> the dense three.
So the recommendation does not depend on getting that constant right; only the absolute
tok/s does. All four MoEs clear 10 tok/s even at the pessimistic 1.2 GB/s/core.

### Sensitivity: usable VRAM is worth a lot

At 15.0 GiB usable nothing runs at zero offload. At 15.5 GiB (headless, or WSL with the
desktop on the iGPU) **Muse-Glimmer-30B IQ4_XS becomes fully resident and jumps 9.0 ->
14.5 tok/s**. Freeing ~500 MB of VRAM is worth more than any flag on the dense models.

### Dense vs MoE, quantified

Dense models read *every* weight *every* token, so partial offload is punishing: at only 2%
offload Muse-Glimmer already loses a third of its speed. The MoEs read ~3B active params,
so the same 25% offload costs them far less in absolute bytes. That is why the four MoEs
sit at 11-39 tok/s and the three dense models at 1.5-9.0 tok/s.

## 2026-09-02 — deliverables and verification

- `planner.js` is a straight port of `vram_model.py`. Cross-checked by generating 28 reference
  points (7 models x 2 contexts x 2 KV types) in Python and re-computing them in Node:
  **all 28 match on both chosen quant and tok/s** (< 1e-4). Worth doing — the port initially
  disagreed because `Mdl.GIB` was undefined after a refactor, silently producing
  `vram_usable_bytes: NaN` and a page that claimed nothing fits.
- `planner.html` renders correctly in light and dark, no console errors, and degrades with a
  clear message when opened over `file://` (browsers block `fetch` there; GitHub Pages is fine).
- Also verified the failure path: GLM at 64k, f16 KV, pessimistic MHA reading -> "does not fit
  at any offload level", which is right (470 KiB/token x 65536 = ~30 GB of cache).

### `-ncmoe` counts MoE layers, not all layers

Easy mistake, caught while writing the command lines: `--n-cpu-moe N` acts on layers that
actually carry expert weights. Nemotron has 52 layers but only **23** MoE ones, so `-ncmoe`
saturates at 23 and a value derived from 52 would over-offload badly. GLM has 47 layers but
46 MoE ones (first layer is a dense FFN in GLM MoE models). Added `n_moe_layers` to
models.json and used it for every generated command line.

### Still open, for whoever runs this on the real machine

1. **GLM-4.7-Flash: MLA or MHA?** One line of llama.cpp startup output settles it, and it is
   the difference between 35.6 and 8.9 tok/s.
2. **Nemotron's real Q4 file size.** The quoted 25.48 GB is 6.79 bits/param and cannot be
   Q4_K_M for a 30B model.
3. **Does llama.cpp actually do MTP self-speculation** for any of Qwen3.6 / Nemotron / GLM?
   Worth ~1.6x, and worth more than usual here because verifying several tokens per forward
   pass amortises the expensive CPU-side expert reads.
4. **The 2.2 GB/s-per-core constant.** Biggest lever on absolute numbers; `--calibrate` fits
   it from bench.csv. Ranking is stable regardless.
