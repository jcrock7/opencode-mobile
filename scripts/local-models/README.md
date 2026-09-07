# Local models for OpenCode on a 12 GB GPU laptop

Scripts to serve Qwen coding models with `llama-server` on a laptop with a
12 GB Blackwell GPU (RTX PRO 3000) and 32 GB of RAM, and to point OpenCode at
them. Two profiles are defined:

| Profile | Model | Why | Default context | Expected speed |
|---|---|---|---|---|
| `fast` | Qwen3.6-35B-A3B (MoE, ~3B active) | Long context and high tok/s. Experts sit in RAM, attention and KV cache sit in VRAM. | 131072 (native max 262144) | 30 to 80 tok/s with MTP |
| `smart` | Qwen3.8-27B (dense) | Best coding quality that fits. Needs most of the GPU and CPU offload for the rest. | 98304 | 5 to 10 tok/s with MTP |

Both use Unsloth dynamic Q4 GGUFs with the multi-token-prediction (MTP) head,
so llama.cpp can run speculative decoding with no extra draft model.

## Files

- `serve-local-models.sh` for Linux and WSL2.
- `serve-local-models.ps1` for native Windows PowerShell.
- `opencode.local-models.example.json` shows the OpenCode provider entries.

## Prerequisites

1. A recent llama.cpp build with CUDA (the prebuilt `cuda` release zip works).
   `llama-server` must be on `PATH`, or set `LLAMA_SERVER` to its full path.
   MTP needs a build from May 2026 or later.
2. `curl` (bash version only).
3. About 40 GB of free disk for both GGUFs. They download automatically into
   `LLAMA_CACHE` on first start (`~/.cache/llama.cpp` or
   `%LOCALAPPDATA%\llama.cpp` by default).

## Usage

```bash
./serve-local-models.sh start fast      # first run downloads ~21 GB, then serves on :8081
./serve-local-models.sh switch smart    # stops fast, starts smart on :8082
./serve-local-models.sh status          # what is running, plus RAM and VRAM
./serve-local-models.sh stop            # stop everything
./serve-local-models.sh cmd fast        # print the llama-server command without running it
```

PowerShell uses the same verbs: `.\serve-local-models.ps1 start fast`.

The script refuses to start a second profile while the first is running. On
this hardware the two models do not fit together (see the memory budget
below). Set `FORCE=1` to override if you know your numbers are different.

## Point OpenCode at the servers

Merge `opencode.local-models.example.json` into your user config
(`~/.config/opencode/opencode.json`), not into this repository's
`opencode.json`. It registers both endpoints so you can pick either model
from OpenCode's model list. Only the profile that is currently running will
answer, so switch with the script before switching models in OpenCode.

Keep the `limit.context` values in sync with `FAST_CTX` and `SMART_CTX`.
Without a limit OpenCode may send more tokens than the server accepts.

## Memory budget: will Claude Code still fit?

Yes, as long as only one profile runs at a time. Rough resident figures with
the default settings:

| Consumer | RAM | VRAM |
|---|---|---|
| Windows or Linux desktop, browser, IDE | 5 to 7 GB | ~0.5 GB |
| One Claude Code session (Node process) | 0.5 to 1.5 GB | 0 |
| `fast` (35B-A3B, 32 of 40 expert layers in RAM) | ~15 GB | ~10.5 GB |
| `smart` (27B, 32 of 64 layers on GPU) | ~9 GB | ~11 GB |

- **`fast` running:** about 22 to 24 GB committed, leaving 8 to 10 GB for
  Claude Code sessions and anything else. Comfortable for two or three
  sessions. If you also run heavy IDE tooling, lower the RAM share by
  pulling more experts onto the GPU (`FAST_NCMOE=28`) or drop to
  `FAST_HF=unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q3_K_XL`, which saves about
  5 GB.
- **`smart` running:** about 16 to 18 GB committed, leaving roughly 14 GB.
  Plenty of room.
- **Both running:** not viable. The model weights alone want about 24 GB of
  RAM plus 21 GB of VRAM. The script blocks this by default.

The GGUFs are memory-mapped, so Task Manager or `free` may show the whole
file in page cache. That cache is reclaimable; the numbers above are the
pages the server actually keeps hot.

## Tuning

All knobs are environment variables. The defaults are conservative so the
first start does not run out of VRAM.

| Variable | Default | Effect |
|---|---|---|
| `FAST_CTX` / `SMART_CTX` | 131072 / 98304 | Context window. KV cache is small on these hybrid-attention models; `fast` can usually take 262144. |
| `FAST_NCMOE` | 32 | Expert layers kept in RAM (of 40). Lower for speed, raise if VRAM overflows. |
| `SMART_NGL` | 32 | Dense layers on the GPU (of 64). Raise for speed, lower if VRAM overflows. |
| `KV_TYPE` | q8_0 | KV cache type. `q4_0` roughly doubles context for a small quality cost. |
| `MTP` | 1 | Speculative decoding with the built-in MTP head. Set `0` if the GGUF lacks one or the build is old. |
| `FAST_HF` / `SMART_HF` | Unsloth UD-Q4_K_XL | `repo:quant` passed to `-hf`. |
| `EXTRA_ARGS` | empty | Appended verbatim, e.g. `--fit-target 64`. |

MTP keeps its own draft KV cache, which costs VRAM. If enabling it shrinks
the context you can fit, try `--spec-draft-n-max 1` via `EXTRA_ARGS`, or
raise `FAST_NCMOE` / lower `SMART_NGL` by a few layers.

Watch the first start with `tail -f ~/.local/state/local-models/fast.log`.
If the process exits with a CUDA out-of-memory error, the script prints the
tail of the log and which knob to move.
