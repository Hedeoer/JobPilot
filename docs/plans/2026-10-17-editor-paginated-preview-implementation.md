# 编辑区实时分页预览 — 实现方案（修订版）

日期：2026-10-17
目标：编辑简历时实时看到**精确页数**、**页边界线**、**当前页**，不必先导出 PDF。
范围：desktop 编辑器（web 为观察态，不在本次范围）

---

## 1. 交付形态

```
┌─ 预览面板 ────────────────────────────────────────┐
│ 预览                    [共 3 页] [-] 90% [+] [⟳] │ ← 页数徽章（实测）+ 刷新
│ ┌──────────────────────────────┐                 │
│ │  第 1 页内容                  │  ← A4 纸（794px）
│ ├┄┄┄┄┄┄Ⓟ2 第 1 页结束 ┄┄┄┄┄┄┄┄┤  ← 单栏：横贯线；双栏：按栏分段画线
│ │  第 2 页内容                  │                 │
│ ├┄┄┄┄┄┄Ⓟ3 第 2 页结束 ┄┄┄┄┄┄┄┄┤                 │
│ │  第 3 页内容                  │                 │
│ └──────────────────────────────┘                 │
│                          第 2 / 3 页 ●            │ ← 当前页指示
└───────────────────────────────────────────────────┘
```

- **页数**：实测，来自与导出完全同源的渲染管线（本机 Chrome `--print-to-pdf`），覆盖全部 51 个模板。
- **分页线**：按 PDF 每页文本在预览 DOM 中做语义定位（L-gram 单调标注），把线钉在 DOM 节点上；打字时线随内容重排移动（stale 态半透明），停止输入 2s 后探针刷新（fresh 态）。
- **模板分级支持**：
  - 29 个 unified 模板：页数精确 + 分页线完整支持（单栏横贯、双栏按栏分段）
  - 22 个 legacy 模板：页数精确；分页线仅在能锚定时显示并标记近似（原因：这些模板的预览与导出本来就走两套不同代码，实测 `card` 模板导出有 6 处 `Highlights` 而预览为 0，预览本身非所见即所得）
- **无 Chrome / 探测失败**：隐藏徽章或显示"页数不可用"，提供手动刷新；不弹错、不影响编辑。

---

## 2. 核心设计决定（两轮实测依据）

| 决定 | 实测依据 |
|---|---|
| **页数走真实渲染探针，不做 JS 估算** | 探针延迟：热 profile **0.38s**、冷 profile **1.6s**（差异来自 Google Fonts 缓存）；5 次产出 PDF 字节完全一致（157053B）。桌面导出（`storage.rs::write_pdf_export`）无 auto-shrink 后处理 → 探针页数 = 导出页数 100% 同源 |
| **Rust 侧直接用 `pdf-extract` 按页取文本** | `pdf-extract 0.7.12` 已在 `Cargo.toml` 中，且提供 `extract_text_from_mem_by_pages(&bytes) -> Result<Vec<String>>`。实测编译运行：中文、`fi/ffl` 连字、多页切分全部正确，`pages.len()` 即页数 → **零新增依赖**（连 `lopdf` 都不必显式引入），IPC 只传页数 + 每页文本 |
| **废除几何推定（原方法 A），只用文本锚定** | 实测：在 `builders.ts` 的 `break-inside: avoid` 规则下，原子块放不下被整块推到下一页，页底留白逐页累积；纯几何公式 `y = pad + k·U` 在第 2–5 页的漂移达 **164 / 258 / 353 / 449px**（近半页）。連带收益：无需新增 `page-geometry.ts`、无需重构 `builders.ts` |
| **文本锚定用 L-gram 单调标注，不依赖 DOM 选择器** | 原方案按 `.item`/`li` 选择器取前缀，在 51 个模板的异构 DOM 下脆弱。改为对文本节点流做 8-gram 单调转移检测（含回溯），实测单栏 4 页、双栏 3 页（高重复度中文 + 重复的"高级工程师 2020 - 2023"标题）**全部锚定，行级误差 0px，块级落在该条目顶部标题行，耗时 ~31ms** |
| **双栏模板按栏分别画线** | 实测 flex 双栏：纯段落左列在 y=1081 换页，含原子块的右列在 y=1980/3077/4168 换页（两列漂移差 185–205px），且左列在第 2 页后就已结束 → 一条横贯线对双栏在物理上是错的 |
| **前端调用 `generateHtml` 前必须走 `toSharedResume` 深拷贝** | `builders.ts:163` 的 `preGenerateQrSvgs` 会原地写入 `(qrSection.content as any)._qrSvgs = svgs`。若把 store 引用直接传入，每 2 秒污染一次 store 并可能被 autosave 落库 |

---

## 3. 数据流

```
useResumeStore（currentResume + sections）
        │
        ├──► ResumePreview（现有实时 DOM，逐键更新）───────────────────┐
        │                                                            │
        └──► [hash 变化] ──idle 2s──► toSharedResume（深拷贝！）       │
                                              │                       │
                                    generateHtml(resume, true)        │
                                              │                       │
                            invoke("preview_resume_pagination",{html})│
                                              │                       │
                         Rust: 常驻 profile Chrome --print-to-pdf     │
                               → validate_pdf_export_output           │
                               → extract_text_from_mem_by_pages       │
                                              │                       │
                                  { pageCount, pageTexts[] }          │
                                              │                       │
                                              ▼                       │
                                  L-gram 单调标注（anchors.ts）◄──────┘
                                              │
                              [{ page, lane, node, offset, x, w }]
                                              │
                                              ▼
                            PaginationOverlay（每次重排从 node 重算 y）
```

---

## 4. 模块清单与目录边界

项目有桌面迁移 lint 门禁（`scripts/verify-desktop-lint-boundary.mjs`）：`src/hooks` 与 `src/lib/*`（未列入白名单的子目录）属于 `WEB_REFERENCE_PATHS`。因此桌面专用逻辑放在 `desktop/src/lib/`，跨端 UI 放在已在白名单内的 `src/components/preview/`。

| 文件 | 动作 | 说明 |
|---|---|---|
| `desktop/src-tauri/src/storage.rs` | 改 | 新增 `preview_resume_pagination` + 常驻 probe profile |
| `desktop/src-tauri/src/lib.rs` | 改 | 注册命令到 `invoke_handler` |
| `desktop/src/lib/desktop-api.ts` | 改 | `previewResumePagination(input)` invoke 包装 |
| `desktop/src/lib/pagination-anchors.ts` | 新增 | L-gram 单调标注纯算法 + DOM 测量封装 |
| `desktop/src/lib/pagination-probe.ts` | 新增 | hash / idle 2s / 单并发 / LRU 缓存 / 失败退避 / React hook `usePaginationProbe` |
| `desktop/src/lib/__tests__/pagination-anchors.test.ts` | 新增 | 标注算法单测（Vitest node 环境跑纯函数） |
| `src/components/preview/pagination-overlay.tsx` | 新增 | 分页线 + 页数徽章 + 当前页指示（纯展示组件） |
| `desktop/src/components/editor/editor-preview-panel.tsx` | 改 | 接入 hook 与 overlay |
| `messages/zh.json` / `messages/en.json` | 改 | `editor.toolbar` 下新增文案 key |
| `scripts/verify-desktop-lint-boundary.mjs` | 改 | 将新增的 `desktop/src/lib/pagination-*.ts` 加入 `DESKTOP_BLOCKING_PATHS` |

**不修改**：`builders.ts`、任何模板文件、`Cargo.toml`（零新增依赖）。

---

## 5. Rust 侧：探针命令

### 5.1 复用 `storage.rs` 现有 helper

| helper | 位置 | 用途 |
|---|---|---|
| `resolve_pdf_browser_path()` | L1038 | 发现本机 Chrome / Edge |
| `file_url_from_path()` | L1536 | 路径转标准 `file:` URL |
| `ensure_storage_directory()` | L1091 | 创建缓存目录 |
| `run_command_with_timeout()` | L64 | 进程执行 + 超时 kill（不调 `wait()`，避免 Windows 管道死锁）+ 稳定性轮询 |
| `observe_stable_pdf_output()` | L40 | 等待 PDF 大小连续 3 次轮询稳定 |
| `validate_pdf_export_output()` | L1576 | `%PDF-` 头校验 + `ERR_FILE_NOT_FOUND` 错误页拦截 |

### 5.2 命令实现要点

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaginationProbeResult {
    pub page_count: usize,
    pub page_texts: Vec<String>,
    pub elapsed_ms: u64,
}
```

流程（放到 `tauri::async_runtime::spawn_blocking`，与 `write_pdf_export` 一致）：

1. 目录：`app_cache_dir()/previews/`；固定文件 `probe.html`、`probe.pdf`（每次先删旧 `probe.pdf`，防止读到上次残留造成假阳性）。
2. **常驻 profile**：`previews/probe-profile/`。
   - 原因：全新 profile 每次重下 Google Fonts（1.6s），复用 profile 命中 HTTP 缓存（**0.38s**）。
   - 锁冲突回退：若本次执行失败，删除 `probe-profile` 下残留的 `Singleton*` 文件并用唯一临时目录 `probe-profile-{ts}` 重试一次（对应 `docs/browser-pdf-export-pitfalls-note.md` 的 profile 锁问题）。
3. Chrome 参数与 `write_pdf_export` 完全一致（保证同源），超时设为 **8s**（导出为 30s）。
4. `validate_pdf_export_output(&probe_pdf)` 校验通过后读取字节，调用：
   ```rust
   let pages = pdf_extract::extract_text_from_mem_by_pages(&bytes)
       .map_err(|e| format!("failed to extract pdf pages: {e}"))?;
   ```
   `page_count = pages.len().max(1)`；每页文本做空白折叠后截断至 2000 字符（足够覆盖页首锚定，控制 IPC 体积）。
5. **并发互斥**：进程内加 `static PROBE_LOCK: Mutex<()>`，防止两个探针同时写同一份 `probe.pdf` / 同一个 `probe-profile`。

---

## 6. 分页线定位算法（`pagination-anchors.ts`）

### 6.1 为什么不用选择器 / 不用几何公式

- 几何公式 `y = pad + k·U` 不知道 `break-inside: avoid` 造成的页底留白，实测 5 页漂移 449px。
- 选择器方案依赖 `.item` 等类名，51 个模板写法不一。
- **L-gram 单调标注**只依赖两个事实：① 同一栏内文本在预览与 PDF 中顺序一致；② 换页处左边的词在页 `cur`、右边的词在页 `cur+1`。

### 6.2 分栏识别（支持双栏模板）

在模板根节点 `root`（`[data-theme-scope] > div`）下识别独立的纵向文本流（lane）：

- 若 `root`（或其唯一子容器）为 `display: flex | grid` 且有两个以上纵向并排的子列（`getBoundingClientRect().left` 互不相同）→ 每个子列是一条独立 lane。
- 否则整个 `root` 作为单条主 lane。

### 6.3 算法步骤（已通过原型实测）

```
常量: L = 8（gram 长度）, RUN = 4（连续确认窗口）
归一化: norm(s) = s.replace(/[\s\u200b-\u200d\ufeff]+/g, "")

输入: root: HTMLElement, pageTexts: string[]
输出: BoundaryAnchor[]   // { page, laneEl, node, offset, blockEl }

1. 为每一页 k 构建 8-gram 集合:
   G[k] = Set( norm(pageTexts[k]) 的所有长度 8 子串 )

2. 对每条 lane，用 TreeWalker(SHOW_TEXT) 收集非空白字符序列:
   lane.str: string
   lane.map[i] = [textNode, charOffsetInNode]   // 第 i 个非空白字符对应的 DOM 位置

3. 单调扫描该 lane（cur = 0, run = 0, lastP = -1）:
   for i = 0 .. lane.str.length - L:
     g = lane.str.slice(i, i + L)
     if !G[cur].has(g) && G[cur + 1].has(g):
       if ++run === RUN:
         p = i - RUN + 1
         // 回溯：若页首是重复短语（如"高级工程师 2020 - 2023"），其 gram 同时属于
         // G[cur] 和 G[cur+1]，触发点会偏后到第一个唯一词处；向前回溯到属于 G[cur+1] 的最左端
         floor = max(lastP + 1, p - 200)
         while p - 1 >= floor && G[cur + 1].has(lane.str.slice(p - 1, p - 1 + L)):
           p--
         lastP = p
         记录锚点 { page: cur + 2, laneEl, ...lane.map[p] }
         cur++; run = 0
     else:
       run = 0
```

- **块级对齐**：拿到 `(node, offset)` 后，若它位于某条目的首行（向上找最近的块级容器 `el`，若 `node` 距 `el` 顶部 < 1 行高），则用 `el` 的上边缘作为分页线 y（视觉上把线画在标题/条目的正上方，而不是贴着文字顶边）。实测中那 `-33px` 就是从唯一 token 回溯到条目顶部 `<b>高级工程师</b>` 的高度差。
- **纯函数可测性**：步骤 1–3 的核心转移逻辑抽成 `findPageTransitionIndices(laneStr: string, pageTexts: string[]): Array<{ page: number; charIndex: number }>`，不碰 DOM，直接用 Vitest 在 node 环境下做单测。

### 6.4 坐标换算（兼容 CSS `zoom`）

```ts
const rootRect = root.getBoundingClientRect();
const scale = rootRect.height / root.offsetHeight || 1;   // 实测有效缩放比

const range = document.createRange();
range.setStart(anchor.node, anchor.offset);
range.setEnd(anchor.node, anchor.offset + 1);
const rect = range.getClientRects()[0];
const laneRect = anchor.laneEl.getBoundingClientRect();

const y = Math.round((rect.top - rootRect.top) / scale);
const x = Math.round((laneRect.left - rootRect.left) / scale);
const width = Math.round(laneRect.width / scale);
```

- 分页线存的是 `{ node, offset, laneEl }` 引用，**不是固定 y**。
- 当用户在第 1 页打字导致 DOM 重排时，`ResizeObserver` 触发重算 `y`（< 1ms），分页线立即跟着内容下移，不会停在原地穿字而过；2s 后新探针返回再更新锚点。
- 若打字过程中 `anchor.node.isConnected === false`（该节点被删）→ 该条线暂时隐藏，等探针刷新。

---

## 7. 探针编排（`pagination-probe.ts`）

| 项 | 规则 |
|---|---|
| 输入构造 | `const shared = toSharedResume({ ...currentResume, sections }, sections)` → `await generateHtml(shared, true)`。**严禁**跳过 `toSharedResume` 直接传 store 对象；**严禁**调 `prepareDesktopPdfHtml`（那是 Smart One-Page 用的整体缩放脚本） |
| 触发指纹 | `hash = JSON.stringify([currentResume.template, currentResume.language, currentResume.themeConfig, sections])` |
| 延迟策略 | 模板 / `themeConfig` 变化 → **300ms**；正文 `sections` 变化 → **idle 2000ms** |
| 竞态防护 | 每次发起探针记录 `reqHash`；返回时若 `reqHash !== currentHash`，结果仍写入 LRU 缓存，但只更新 `pageCount`（标 stale），不绑新锚点（因为当前 DOM 已不属于 `reqHash`），随即由 pending 触发下一轮 |
| 并发 | 单并发；进行中再次触发只记 `pending = true`，当前完成后立即跑最新状态 |
| 缓存 | `Map<hash, PaginationProbeResult>`，上限 8 条（LRU），切回旧模板/撤销时 0ms 命中 |
| 窗口失焦 | `document.hidden || !document.hasFocus()` 时暂停自动探测；回到焦点后若处于 stale 则补跑一次 |
| 失败退避 | 连续失败 3 次 → 置 `status = 'unavailable'`，停止自动探测；点击刷新按钮重置计数 |
| 空简历短路 | 可见 section 全空时直接返回 `pageCount = 1, boundaries = []`，不调 Rust |

---

## 8. Overlay 组件（`pagination-overlay.tsx`）

- **挂载位置**：`desktop/src/components/editor/editor-preview-panel.tsx`
  - 顶部工具栏加入页数徽章与刷新按钮（紧邻缩放控件左侧）
  - A4 纸容器（`width: A4_WIDTH` 的那个 `div`，需加 `position: relative`）内渲染 `<PaginationOverlay />`
  - 右下角浮动胶囊显示 `第 {current} / {total} 页`
- **分页线样式**：
  - `position: absolute; top: ${y}px; left: ${x}px; width: ${width}px`
  - 1px 虚线 + 左端小胶囊 `P{page}`（点击滚动到该页：`scrollContainer.scrollTo({ top: y * scale - 24, behavior: 'smooth' })`）
  - `status === 'stale'` 时整条线 `opacity-45`；legacy 模板且仅部分页锚定成功时，徽章提示"部分分页线为近似位置"
- **当前页计算**：
  - 监听滚动容器 `scroll`（rAF 节流）
  - 视口中心在设计坐标下的位置：`centerY = (scrollTop + clientHeight / 2) / scale`
  - 每页的设计坐标区间由各页最靠上的边界线 `y_2 < y_3 < ... < y_N` 划分（无边界线时按 `scrollHeight / pageCount` 均分兜底）→ `centerY` 落入第几段即为当前页

---

## 9. i18n（避免复数陷阱）

`messages/zh.json` 与 `messages/en.json` 由 web（next-intl）和 desktop（i18next，`prefix: "{"`）共用，避免使用 ICU plural 语法，采用中性表述：

| key（位于 `editor.toolbar` 下） | zh | en |
|---|---|---|
| `paginationPages` | `共 {count} 页` | `Pages: {count}` |
| `paginationCurrent` | `第 {current} / {total} 页` | `Page {current} / {total}` |
| `paginationUpdating` | `正在计算页数…` | `Calculating pages…` |
| `paginationStale` | `内容已更改，停止输入后更新页数` | `Modified — page count updates when idle` |
| `paginationUnavailable` | `页数不可用` | `Page count unavailable` |
| `paginationRefresh` | `重新计算页数` | `Recalculate pages` |
| `paginationPageStart` | `第 {page} 页开始` | `Start of page {page}` |

---

## 10. 风险与边界处理

| 风险 / 场景 | 处理 |
|---|---|
| **macOS / Windows 上 Chrome 冷启动慢于 Linux**（Linux 实测 0.38s，macOS/Win Defender 可能 0.8–1.5s） | 探针结果带 `elapsedMs`；若运行中连续 3 次 `elapsedMs > 1500`，自动把 idle 阈值从 2000ms 上调到 3500ms。若后续证明仍不够快，备选升级是常驻 headless Chrome + CDP `Page.printToPDF`（本次不做） |
| **本机未安装 Chrome / Edge** | `resolve_pdf_browser_path` 返回 Err → 前端静默进入 `unavailable`，不弹窗 |
| **probe-profile 被残留锁文件卡住** | Rust 侧自动清 `Singleton*` 并用临时 profile 重试一次 |
| **整页只有纯重复文本或图片，L-gram 无法唯一转移** | 该页不产出边界线，但 `pageCount` 仍然准确；绝不画错位置误导用户 |
| **22 个 legacy 模板预览与导出 DOM 不一致** | 页数仍 100% 准；锚不上的页不画线 |
| **编辑触发 `generateHtml` 污染 store** | 强制走 `toSharedResume` 深拷贝，单测覆盖"调用探针前后 store 引用深相等" |

---

## 11. 验收标准

1. **门禁全绿**：
   - `pnpm type-check`
   - `pnpm --filter @jobpilot/desktop test`（含 `pagination-anchors.test.ts`）
   - `pnpm --filter @jobpilot/desktop build`
   - `cargo check --manifest-path desktop/src-tauri/Cargo.toml`
   - `pnpm run lint:desktop:active` 与 `pnpm run lint:desktop:shared`
2. **页数一致性**：抽样 8 个模板（普通单栏 `classic`/`ats`、BACKGROUND `modern`/`gradient`、侧栏深色 `sidebar`/`two-column`、全深色 `neon`、legacy `card`）× 3 档长度（1 页、2 页、3+ 页），预览徽章页数与实际导出 PDF 页数 **100% 一致**。
3. **分页线准确性（unified 模板）**：每页分页线紧贴 PDF 对应页首段内容在预览中的上方（块级误差 ≤ 1 行，不穿字、不跨错条目）；双栏模板左右两栏各自画在对应列的换页处，已结束的列不再画后续页的线。
4. **交互与稳定性**：
   - 在第 1 页插入大段文字时，已有分页线实时跟随内容下移（不滞留在原坐标穿字），2s 后更新到新页界
   - 删减内容回到 1 页 → 分页线消失，徽章变为 `共 1 页`
   - zoom 30%–150% 切换，分页线相对文字位置不变
   - 连续打字 30s 不产生并发 Chrome 进程；store 中不出现 `_qrSvgs` 字段
   - 把 `CHROME_PATH` 指向无效路径时，编辑器正常工作、无报错弹窗

---

## 附录：两轮实测记录（全部来自本机现场实验）

| # | 实验 | 结果 |
|---|---|---|
| 1 | Chrome `--print-to-pdf` 延迟（含 Google Fonts） | 冷 profile 3 次：**1589 / 1621 / 1617ms**；复用 profile 2 次：**382 / 383ms**；5 次 PDF 均为 157053B |
| 2 | CSS `zoom` 对度量的影响 | `zoom: 1 / 0.9 / 0.75` 下 `offsetHeight` = 4200 / 4198 / 4200；`getBoundingClientRect().height / offsetHeight` 精确等于 `zoom` |
| 3 | 原"方法 A 几何公式 `pad + k·U`"在真实 break 规则下的偏差 | 5 页文档第 2–5 页漂移 **164 / 258 / 353 / 449px**（证伪方法 A） |
| 4 | flex 双栏两列换页位置 | 左列 y=1081（第 2 页后结束）；右列 y=1081 / 1980 / 3077 / 4168（证伪横贯单线） |
| 5 | `pdf_extract::extract_text_from_mem_by_pages`（0.7.12，真实编译 Rust 验证） | 中文、`fi/ffl` 连字、5 页合成简历全部按页正确切分，与 mupdf 逐页结果一致 |
| 6 | L-gram（L=8, RUN=4 + 回溯）锚定原型（`zoom: 0.75` + 高重复中文 + 重复标题） | 单栏 4 页（3 条线）+ 双栏 3 页（左右各 2 条线）全部命中：行内断页误差 **0px**，条目断页回溯到标题行上沿（-33px），总耗时 **31–36ms** |
| 7 | legacy `card` 模板预览 vs 导出同源性检查 | `Highlights`：导出 6 处 / 预览 0 处；`职责`：预览 2 / 导出 1 |
| 8 | `generateHtml` 入参副作用检查 | `builders.ts:163` 原地写 `qrSection.content._qrSvgs`；`toSharedResume` 内 `cloneContent` 做 `JSON.parse(JSON.stringify(...))` 可隔离 |
