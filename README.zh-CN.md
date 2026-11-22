# VramDeck

[![CI](https://github.com/Aoike123/VramDeck/actions/workflows/ci.yml/badge.svg)](https://github.com/Aoike123/VramDeck/actions/workflows/ci.yml)
![Node >=22.19](https://img.shields.io/badge/node-%3E%3D22.19-339933)
![OS](https://img.shields.io/badge/OS-Linux%20%7C%20macOS%20%7C%20Windows-blue)

**把大语言模型、文生图、视频生成和语音工具一起跑在 1–4 张显卡上——不爆显存（OOM），不折腾端口，也不用手动反复重启。**

[English (README.md)](README.md) · [文档索引](docs/README.md) · [20 分钟接入新引擎](docs/guide/ADD_ENGINE.md) · [贡献指南](CONTRIBUTING.md)

---

## 为什么选择 VramDeck？

当你在一台家用 PC 或 2–4 卡工作站上同时使用本地编程模型、ComfyUI 生图/视频工作流、Whisper 语音识别或 TTS 时，很快会遇到端口混乱、显存打架和手动杀进程的麻烦。**VramDeck** 为你的所有本地 AI 引擎提供一个统一的显存调度中枢、单一 API 网关与实时控制台：

- **自动显存编排（告别 OOM）**：显存充足时让轻量模型共享同一张显卡；运行大模型时跨多卡原子预留显存；从对话切换至生图或视频生成时自动排队并优雅让位，无需手工关停服务。
- **零侵入接管已有工具**：一键扫描并接管本机正在运行的 **Ollama**、**ComfyUI**、**LM Studio** 和 **llama.cpp** 服务；也可以直接按需拉起原生进程（`llama.cpp`、`whisper.cpp`、`kokoro`）或 Docker 容器（`vLLM`）。
- **一个网关、一个 MCP 接入全部客户端**：Cursor、Open WebUI、Cherry Studio、Continue 和自研脚本只需接入同一套 OpenAI 兼容网关（`http://127.0.0.1:18982/v1`）；AI Agent 通过 `platforms/mcp/server.mjs`（`local-media`）即可按需发现并调用本地生图、视频、语音合成与转录工具。
- **看清显存再下载（模型中心 Hub）**：拉取权重前实时标注当前显卡是否放得下（`可流畅运行` / `显存较紧` / `显存不足`），支持 **Hugging Face**、**HF-Mirror**、**ModelScope** 断点续传与 SHA256 校验，也支持直接挂载本地已有模型目录。
- **开箱即用的双语控制台**：打开 `http://127.0.0.1:13000` 即可实时查看多卡显存占用、温度与算力负载、任务队列、作品库、API 密钥，并支持右上角 `EN` / `中文` 无刷新切换。

---

## 工作原理

```text
  应用 / IDE / Agent              VramDeck 控制平面                      底层引擎与硬件
┌──────────────────────┐      ┌────────────────────────┐      ┌──────────────────────────────────┐
│ Cursor / Open WebUI  │─────▶│ 统一网关 (:18982 /v1)  │─────▶│ 一键接管：Ollama · ComfyUI · LM  │
│ 业务脚本 / SDK       │      │ 队列 · 租约 · 密钥额度 │      │ 原生托管：llama.cpp · vLLM       │
├──────────────────────┤      ├────────────────────────┤      │ 音频语音：whisper.cpp · Kokoro   │
│ Claude / MCP 客户端  │─────▶│ MCP (local-media)      │      ├──────────────────────────────────┤
├──────────────────────┤      ├────────────────────────┤      │ 1–4 卡 / 混插显卡 / CPU 模式     │
│ 浏览器控制台         │─────▶│ Web 面板 (:13000)      │      │ CUDA · ROCm · Metal · Vulkan     │
└──────────────────────┘      └────────────────────────┘      └──────────────────────────────────┘
```

---

## 60 秒快速上手

### 1. 运行一键安装脚本

**Linux / macOS：**

```bash
bash scripts/install.sh
```

**Windows (PowerShell)：**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

> 可先追加 `--dry-run`（bash）或 `-DryRun`（PowerShell）安全预览将执行的操作，不修改系统。

### 2. 启动 VramDeck

```bash
node platforms/workbench/cli.mjs start
```

### 3. 打开控制台并发起第一次调用

- **Web 控制台**：访问 `http://127.0.0.1:13000`，查看本机 GPU 拓扑、在 **引擎与模型中心（Hub）** 扫描并接管已有本地服务，或切换 `EN` / `中文`。
- **统一 API 网关**：通过 `http://127.0.0.1:18982/v1` 查询当前可用模型并发起对话请求：

```bash
curl http://127.0.0.1:18982/v1/models

curl http://127.0.0.1:18982/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5:7b",
    "messages": [{"role": "user", "content": "你好，VramDeck！"}]
  }'
```

---

## 适配你的常用工具

| 客户端 / 场景 | 接入方式 | 获得的能力 |
|---|---|---|
| **Cursor / Continue / Open WebUI / Cherry Studio** | 将 OpenAI Base URL 设为 `http://127.0.0.1:18982/v1` | 单一入口调用 Ollama、llama.cpp、vLLM，多模型切换不再撞显存 |
| **Claude Desktop / MCP Agent** | 配置 stdio 启动命令：`node platforms/mcp/cli.mjs stdio` | 启动 `local-media` MCP 服务（核心模块见 [platforms/mcp/server.mjs](platforms/mcp/server.mjs)），分级暴露生图、视频、TTS 与语音识别工具 |
| **已有 Ollama / ComfyUI / LM Studio** | 打开控制台（`:13000`）-> **引擎与模型中心** -> **扫描本机服务** -> **一键接管** | 保留原有配置与模型权重，立刻获得统一显存调度、API 路由与监控图表 |

---

## 硬件与系统支持矩阵

| 厂商 / 计算后端 | 支持操作系统 | 自动发现方式 | 兼容引擎生态 |
|---|---|---|---|
| **NVIDIA CUDA** (`cuda`) | Linux、Windows（含 WSL2） | `nvidia-smi` 实时监控 | `llama.cpp`、`Ollama`、`vLLM`、`ComfyUI`、`whisper.cpp`、`Kokoro` |
| **AMD ROCm** (`rocm`) | Linux、Windows | sysfs / `rocm-smi` / `amd-smi` / CIM | 通用引擎生态 + 可选 ROCm Pro 专精包 |
| **Apple Silicon Metal** (`metal`) | macOS (`arm64`) | 统一内存预算探测（`sysctl` + `vm_stat`） | `llama.cpp`、`Ollama`、`ComfyUI`、`whisper.cpp`、`Kokoro` |
| **Intel / Vulkan** (`vulkan`) | Linux、Windows | `vulkaninfo` / sysfs | `llama.cpp`、`ComfyUI`、`whisper.cpp` |
| **纯 CPU 模式** (`cpu`) | Linux、macOS、Windows | 宿主内存与系统资源采集 | `llama.cpp`、`Ollama`、`ComfyUI`、`whisper.cpp`、`Kokoro` |

---

## 文档与扩展开发

- **全部文档索引**：[docs/README.md](docs/README.md)
- **20 分钟接入新引擎**：[docs/guide/ADD_ENGINE.md](docs/guide/ADD_ENGINE.md)
- **参与贡献与新手任务**：[CONTRIBUTING.md](CONTRIBUTING.md)
- **一键安装脚本**：[scripts/install.sh](scripts/install.sh) · [scripts/install.ps1](scripts/install.ps1)

<details>
<summary>可选 ROCm Pro 加速包与传统命令兼容说明</summary>

- 针对 AMD Radeon 工作站显卡的预调优容器镜像包已保留为可选的 **ROCm Pro Pack**（`rocm-pro`）。
- 原有 `./lab` 命令入口与 `.llm-backend-artifacts` 数据目录标记保持完全兼容（`./lab start`、`./lab check`）。

</details>
