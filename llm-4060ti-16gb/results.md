# Generated results — vram_model.py

Baseline: no speculative decoding. Regenerate with `python3 vram_model.py --table`.

```

RTX 4060 Ti 16 GB + 48 GB DDR4-3200 | KV cache = q8_0 | target > 10 tok/s
Baseline assumes NO speculative decoding. 'MTP?' is the upside IF llama.cpp
implements self-speculation for that architecture (1.6x) -- verify, do not assume.

model                    quant         32k t/s   off  64k t/s   off  MTP? 32k  max ctx
--------------------------------------------------------------------------------------
Qwen3.6-35B-A3B-MTP      IQ4_XS           38.9   24%     35.0   26%      62.2     252k
GLM-4.7-Flash            IQ4_XS           35.6   14%     25.9   20%      57.0     124k
NVIDIA-Nemotron-3.5-Ligh UD-Q4_K_XL       30.6   23%     27.2   26%      49.0     252k
Laguna-XS-2.1            Q4_K_M           11.2   27%     10.3   29%         -      80k
Muse-Glimmer-30B         IQ4_XS            9.0    2%      6.2    6%         -      20k
Qwen3.8-27B              IQ4_XS            3.8   11%      2.5   18%       6.1     none
Gemma-4-31B-it           Q4_K_M            1.5   30%      1.2   38%         -     none

note: GLM-4.7-Flash under the pessimistic MHA reading of its attention: fits, 8.9 tok/s
```

## Recommended configurations in detail

```

Qwen3.6-35B-A3B-MTP  [IQ4_XS]  ctx=32,768  kv=q8_0  spec x1.0
--------------------------------------------------------------
  weights on GPU        13.60 GiB
  weights in RAM         4.09 GiB   (24% of expert bytes)
  KV cache               0.35 GiB
  compute + ctx          1.02 GiB
  ---------------------------------
  VRAM total            14.98 GiB  of 15.00 GiB

  bytes read / token: GPU  1491.3 MB   RAM   137.3 MB
  time  / token:  GPU  6.64 ms | RAM 15.60 ms | KV  1.69 ms | overhead 1.80 ms
  => 38.9 tok/s
  flag: -ncmoe 10   [of 40 MoE layers]

Qwen3.6-35B-A3B-MTP  [IQ4_XS]  ctx=65,536  kv=q8_0  spec x1.0
--------------------------------------------------------------
  weights on GPU        13.27 GiB
  weights in RAM         4.43 GiB   (26% of expert bytes)
  KV cache               0.69 GiB
  compute + ctx          1.02 GiB
  ---------------------------------
  VRAM total            14.98 GiB  of 15.00 GiB

  bytes read / token: GPU  1480.1 MB   RAM   148.5 MB
  time  / token:  GPU  6.59 ms | RAM 16.87 ms | KV  3.28 ms | overhead 1.80 ms
  => 35.0 tok/s
  flag: -ncmoe 11   [of 40 MoE layers]

GLM-4.7-Flash  [IQ4_XS]  ctx=32,768  kv=q8_0  spec x1.0
--------------------------------------------------------------
  weights on GPU        13.06 GiB
  weights in RAM         2.03 GiB   (14% of expert bytes)
  KV cache               0.88 GiB
  compute + ctx          1.02 GiB
  ---------------------------------
  VRAM total            14.96 GiB  of 15.00 GiB

  bytes read / token: GPU  1483.9 MB   RAM   136.1 MB
  time  / token:  GPU  6.61 ms | RAM 15.46 ms | KV  4.20 ms | overhead 1.80 ms
  => 35.6 tok/s
  flag: -ncmoe 6   [of 46 MoE layers]

GLM-4.7-Flash  [IQ4_XS]  ctx=65,536  kv=q8_0  spec x1.0
--------------------------------------------------------------
  weights on GPU        12.19 GiB
  weights in RAM         2.90 GiB   (20% of expert bytes)
  KV cache               1.76 GiB
  compute + ctx          1.02 GiB
  ---------------------------------
  VRAM total            14.97 GiB  of 15.00 GiB

  bytes read / token: GPU  1425.6 MB   RAM   194.4 MB
  time  / token:  GPU  6.35 ms | RAM 22.09 ms | KV  8.39 ms | overhead 1.80 ms
  => 25.9 tok/s
  flag: -ncmoe 9   [of 46 MoE layers]

NVIDIA-Nemotron-3.5-Lightning-30B-A3B  [UD-Q4_K_XL]  ctx=32,768  kv=q8_0  spec x1.0
--------------------------------------------------------------
  weights on GPU        13.49 GiB
  weights in RAM         3.74 GiB   (23% of expert bytes)
  KV cache               0.43 GiB
  compute + ctx          1.02 GiB
  ---------------------------------
  VRAM total            14.94 GiB  of 15.00 GiB

  bytes read / token: GPU  1661.7 MB   RAM   188.3 MB
  time  / token:  GPU  7.40 ms | RAM 21.40 ms | KV  2.07 ms | overhead 1.80 ms
  => 30.6 tok/s
  flag: -ncmoe 5   [of 23 MoE layers]

NVIDIA-Nemotron-3.5-Lightning-30B-A3B  [UD-Q4_K_XL]  ctx=65,536  kv=q8_0  spec x1.0
--------------------------------------------------------------
  weights on GPU        13.08 GiB
  weights in RAM         4.15 GiB   (26% of expert bytes)
  KV cache               0.83 GiB
  compute + ctx          1.02 GiB
  ---------------------------------
  VRAM total            14.94 GiB  of 15.00 GiB

  bytes read / token: GPU  1641.2 MB   RAM   208.8 MB
  time  / token:  GPU  7.31 ms | RAM 23.73 ms | KV  3.97 ms | overhead 1.80 ms
  => 27.2 tok/s
  flag: -ncmoe 6   [of 23 MoE layers]

Laguna-XS-2.1  [Q4_K_M]  ctx=32,768  kv=q8_0  spec x1.0
--------------------------------------------------------------
  weights on GPU        13.60 GiB
  weights in RAM         5.31 GiB   (27% of expert bytes)
  KV cache               0.35 GiB
  compute + ctx          1.02 GiB
  ---------------------------------
  VRAM total            14.97 GiB  of 15.00 GiB

  bytes read / token: GPU  1107.9 MB   RAM   712.8 MB
  time  / token:  GPU  4.93 ms | RAM 81.00 ms | KV  1.66 ms | overhead 1.80 ms
  => 11.2 tok/s
  flag: -ncmoe 11   [of 40 MoE layers]

Laguna-XS-2.1  [Q4_K_M]  ctx=65,536  kv=q8_0  spec x1.0
--------------------------------------------------------------
  weights on GPU        13.20 GiB
  weights in RAM         5.70 GiB   (29% of expert bytes)
  KV cache               0.68 GiB
  compute + ctx          1.02 GiB
  ---------------------------------
  VRAM total            14.91 GiB  of 15.00 GiB

  bytes read / token: GPU  1055.1 MB   RAM   765.6 MB
  time  / token:  GPU  4.70 ms | RAM 87.00 ms | KV  3.25 ms | overhead 1.80 ms
  => 10.3 tok/s
  flag: -ncmoe 12   [of 40 MoE layers]

Muse-Glimmer-30B  [IQ4_XS]  ctx=32,768  kv=q8_0  spec x1.0
--------------------------------------------------------------
  weights on GPU        13.44 GiB
  weights in RAM         0.34 GiB   (2% of expert bytes)
  KV cache               0.51 GiB
  compute + ctx          1.02 GiB
  ---------------------------------
  VRAM total            14.98 GiB  of 15.00 GiB

  bytes read / token: GPU 14430.0 MB   RAM   370.0 MB
  time  / token:  GPU 64.24 ms | RAM 42.05 ms | KV  2.45 ms | overhead 1.80 ms
  => 9.0 tok/s
  flag: -ncmoe 1   [dense: use -ngl instead]

Muse-Glimmer-30B  [IQ4_XS]  ctx=65,536  kv=q8_0  spec x1.0
--------------------------------------------------------------
  weights on GPU        13.03 GiB
  weights in RAM         0.76 GiB   (6% of expert bytes)
  KV cache               0.94 GiB
  compute + ctx          1.02 GiB
  ---------------------------------
  VRAM total            14.99 GiB  of 15.00 GiB

  bytes read / token: GPU 13986.0 MB   RAM   814.0 MB
  time  / token:  GPU 62.26 ms | RAM 92.50 ms | KV  4.51 ms | overhead 1.80 ms
  => 6.2 tok/s
  flag: -ncmoe 3   [dense: use -ngl instead]
```
