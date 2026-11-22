# VramDeck

**面向 1–4 卡（Few-GPU）的多模态本地 AI 资源管理器与统一控制平面**

> [English README (README.md)](README.md) · [文档索引](docs/README.md) · [20 分钟接入新引擎](docs/guide/ADD_ENGINE.md) · [贡献指南](CONTRIBUTING.md)

**VramDeck**（由 `llm-backend` 演进升级而来）将 1–4 张消费级或工作站显卡（以及无 GPU 的纯 CPU 主机）整合为一套跨平台（**Linux / macOS / Windows**）的统一 OpenAI 兼容网关（`:18982`）、分级加载 MCP 媒体服务（`local-media`）、中英文双语 Web 控制台（`:13000`）与一键下载部署中心。

---

## 核心特性

- **单进程零依赖控制平面**：基于 **Node.js >= 22.19** 原生 TypeScript，不再强绑定 `systemd`、Prometheus 或宿主机 Python 才能启动面板与网关。
- **1–4 卡 Best-Fit 资源池调度**：支持多厂商混合设备（`nvidia:0`、`amd:1`、`apple:0`、`intel:2`），同卡 `shared` 轻量服务共存、多卡张量并行原子预留，并在显存不足时按 `idle -> batch_eligible -> lowest cold_start_weight` 优雅驱逐。
- **三态可插拔驱动（`process` | `docker` | `external`）**：原生子进程拉起 `llama.cpp` / `whisper.cpp` / `kokoro`、容器拉起 `vLLM` 或 **ROCm Pro Pack**，或零侵入接管本机已运行的 `Ollama` / `ComfyUI` / `LM Studio`。
- **引擎与模型 Hub**：自动扫描本机可用服务、按实时可用显存推荐最合适的量化权重（`fits` / `tight` / `too_large`），支持 **Hugging Face / HF-Mirror / ModelScope** 断点续传与 SHA256 校验，并支持挂载本地权重目录。
- **完全向后兼容 `llm-backend` 与 `./lab`**：保留 `llm-backend` 兼容入口、`./lab` 命令与 `.llm-backend-artifacts` 目录标记，并完整保留 8 个 AMD Radeon R9700 / Paiton 引擎（归组为可选 `rocm-pro` 包）。

---

## 快速开始（3 步启动）

### 第 1 步：运行一键安装脚本

**Linux / macOS：**

```bash
bash scripts/install.sh
```

**Windows (PowerShell)：**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

> 可先追加 `--dry-run`（Linux/macOS）或 `-DryRun`（Windows）预览安装动作而不修改系统。

### 第 2 步：启动 VramDeck 控制平面

```bash
node platforms/workbench/cli.mjs start
# 或使用兼容命令入口：
./lab start
```

### 第 3 步：访问控制台与接入网关

- **Web 控制台**：`http://127.0.0.1:13000`（支持右上角/侧边栏 `EN` / `中文` 无刷新切换、多卡显存拓扑图与 Hub 下载中心）
- **OpenAI / 多模态 API 网关**：`http://127.0.0.1:18982/v1`
- **MCP 工具服务端（`local-media`）**：通过 `platforms/mcp/server.mjs` 提供分级加载的 `browse_media` 工具面

---

## 硬件与后端兼容矩阵

| 厂商 / 计算后端 | 支持操作系统 | 自动发现方式 | 可用引擎 |
|---|---|---|---|
| **NVIDIA CUDA** (`cuda`) | Linux、Windows（含 WSL2） | `nvidia-smi` 查询 | `llama.cpp`、`Ollama`、`vLLM`、`ComfyUI`、`whisper.cpp`、`Kokoro` |
| **AMD ROCm** (`rocm`) | Linux、Windows | `rocm-smi` / `amd-smi` / sysfs / CIM | 通用主流引擎 + **ROCm Pro Pack**（8 套 R9700 专精包） |
| **Apple Silicon Metal** (`metal`) | macOS (`arm64`) | 统一内存检测（约 75% 可用预算） | `llama.cpp`、`Ollama`、`ComfyUI`、`whisper.cpp`、`Kokoro` |
| **Intel / Vulkan** (`vulkan`) | Linux、Windows | `vulkaninfo` / sysfs 降级检测 | `llama.cpp`、`ComfyUI`、`whisper.cpp` |
| **CPU 模式** (`cpu`) | Linux、macOS、Windows | 宿主内存监控 | `llama.cpp`、`Ollama`、`ComfyUI`、`whisper.cpp`、`Kokoro` |

---

## 30 秒演示 GIF（录制指南）

> **演示动图占位**：`<!-- 发布版本前可将 1280x720 30s 演示动图放至 docs/assets/vramdeck-demo.gif -->`

推荐 30 秒演示录制剧本：
1. 在双卡或混合显存环境中打开 `http://127.0.0.1:13000`，展示多卡显存拓扑中的并发 `PoolAllocation` 占用槽位。
2. 切入 Hub 页面扫描本机已启动的 Ollama/ComfyUI 服务，点击一键接管并查看不同量化权重的显存适配标签。
3. 在界面中点击 `EN` / `中文` 完成双语切换收尾。

---

## 进阶文档与社区贡献

- **全部文档索引**：[docs/README.md](docs/README.md)
- **20 分钟接入新引擎**：[docs/guide/ADD_ENGINE.md](docs/guide/ADD_ENGINE.md)
- **参与贡献与新手任务**：[CONTRIBUTING.md](CONTRIBUTING.md)
- **一键安装脚本**：[scripts/install.sh](scripts/install.sh) · [scripts/install.ps1](scripts/install.ps1)
