#!/usr/bin/env bash
# Validate the predictions in README.md on the real machine.
#
# Emits bench.csv in exactly the schema vram_model.py --calibrate expects:
#   model_id,quant,ctx,kv_type,cpu_moe_frac,tok_per_s
#
# Usage:
#   ./bench.sh /path/to/model.gguf glm47-flash IQ4_XS
#   ./bench.sh /path/to/model.gguf glm47-flash IQ4_XS "0 4 8 12 16"   # explicit -ncmoe list
#
# Needs llama-bench and llama-cli from a recent llama.cpp build (CUDA).

set -euo pipefail

MODEL="${1:?usage: bench.sh <model.gguf> <model_id> <quant_label> [ncmoe list]}"
MODEL_ID="${2:?}"
QUANT="${3:?}"
NCMOE_LIST="${4:-0 4 8 12 16 24}"
OUT="${OUT:-bench.csv}"
CTXS="${CTXS:-32768 65536}"
KV="${KV:-q8_0}"
NGL="${NGL:-999}"

command -v llama-bench >/dev/null || { echo "llama-bench not on PATH"; exit 1; }

# ---------------------------------------------------------------------------
# Step 0: the single most valuable line of output in this whole script.
# llama.cpp prints the real KV cache size at load. For GLM-4.7-Flash this
# settles the MLA-vs-MHA question that the public sources contradict each
# other on, and it validates the KV model for every other architecture.
# ---------------------------------------------------------------------------
echo "== reported KV cache size at 32k (compare against README's table) =="
llama-cli -m "$MODEL" -c 32768 -ngl "$NGL" -ctk "$KV" -ctv "$KV" -fa on \
          -n 0 -p "x" --no-warmup 2>&1 |
  grep -Ei "KV self size|n_layer|n_head|n_embd_k_gqa|n_embd_v_gqa|kv_lora|model size|expert" || true
echo

# How many layers hold MoE weights, so -ncmoe N can be turned into a fraction.
N_MOE_LAYERS="${N_MOE_LAYERS:-$(llama-cli -m "$MODEL" -c 512 -ngl 0 -n 0 -p x --no-warmup 2>&1 |
  grep -oEi 'n_layer *= *[0-9]+' | grep -oE '[0-9]+' | head -1 || echo 0)}"
echo "n_layer = $N_MOE_LAYERS (used to convert -ncmoe N into a fraction)"

[ -f "$OUT" ] || echo "model_id,quant,ctx,kv_type,cpu_moe_frac,tok_per_s" > "$OUT"

for CTX in $CTXS; do
  for NC in $NCMOE_LIST; do
    echo "--- ctx=$CTX  -ncmoe=$NC ---"
    # -n 128 generation, -p 512 prompt; llama-bench prints "tg128" rows.
    if ! RES=$(llama-bench -m "$MODEL" -ngl "$NGL" -ctk "$KV" -ctv "$KV" -fa 1 \
                 -ncmoe "$NC" -p 512 -n 128 -r 3 -o csv 2>/dev/null); then
      echo "    OOM or unsupported at ncmoe=$NC, ctx=$CTX -- skipping"
      continue
    fi
    TG=$(printf '%s\n' "$RES" | awk -F, 'NR>1 && $0 ~ /tg/ {gsub(/"/,"",$(NF-1)); print $(NF-1)}' | tail -1)
    [ -z "$TG" ] && { echo "    could not parse llama-bench output"; continue; }
    FRAC=$(awk -v n="$NC" -v L="$N_MOE_LAYERS" 'BEGIN{printf "%.4f", (L>0? n/L : 0)}')
    echo "$MODEL_ID,$QUANT,$CTX,$KV,$FRAC,$TG" >> "$OUT"
    echo "    $TG tok/s  (offload fraction $FRAC)"
  done
done

# ---------------------------------------------------------------------------
# Step 2: does this build actually do MTP / self-speculation for this model?
# The README treats MTP as upside precisely because shipping MTP tensors in the
# GGUF does not mean llama.cpp implements it for that architecture.
# ---------------------------------------------------------------------------
echo
echo "== speculative-decoding support check =="
llama-cli -m "$MODEL" -c 4096 -ngl "$NGL" -n 0 -p x --no-warmup 2>&1 |
  grep -Ei "mtp|nextn|speculat|draft" || echo "  no MTP/speculation tensors mentioned at load"

echo
echo "Wrote $OUT. Now run:  python3 vram_model.py --calibrate $OUT"
