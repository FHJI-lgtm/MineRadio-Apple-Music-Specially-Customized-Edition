# Phase 3.8.7 — StateRepository 原始字节扫描（**GUID 部分无效**，字符串部分有效）

**PHASE_3_8 = … + STATE_REPOSITORY_INSPECTED_STRINGS_ONLY**（不变）

证据：`evidence/staterepository-bytescan.txt`（72 行）。**副本未修改**；本轮**未提权**（用上一轮已取得的副本）。

---

## 1. ⚠ 必须先看：GUID 字节扫描 **无效**（我的脚本 bug）

```
Exception calling "ToInt32": Value was either too large or too small for a UInt32.
```

根因：我把「无空格的 ASCII 十六进制形式」也交给同一个 `PatBytes` 解析——
`'F707A913E0CE4FD4BCE3425DD153285B' -split ' '` 只得到一个 32 位十六进制串 → `[Convert]::ToInt32` 溢出抛错 →
函数返回 `$null` → 后续 `[regex]::Escape($null)` 再次抛错 → **那 6 个 pattern 的正则从未被构造**。

**因此输出里的 `PATTERN=… hits=0` 一律不作数，不得解读为"GUID 不存在"。**
（与上一轮 `g6-dllgetclassobject.txt` 同类处理：无效文件不进结论。）
`guidBytesInWindow=0` 同样无效。

**一行修复**：字节模式用 `[Convert]::ToByte($p,16)`（而不是 `ToInt32`）；ASCII 形式直接当字符串用，
不要走 `PatBytes`。→ 下一轮重跑即可。

## 2. ✅ 有效部分：字符串 token 及其 offset（与上一轮独立交叉验证一致）

| token | .srd 命中 | 前几个 offset | .wal / .shm |
|---|---|---|---|
| **`proxyStub`** | **284** | 215141 / 1077032 / 1337655 | 0 / 0 |
| `AppleMusicWin` | **67** | 336562 / 344755 / 394611 | 0 / 0 |
| `AMPLibraryAgent` | **7** | 581482 / 668625 / **1405810** | 0 / 0 |
| `Interface` | 68 | 1790529 / 2004045 / 2004094 | 0 / 0 |
| `Path` | 26 | 7355 / 10548 / 13608 | 0 / 0 |
| `ClassId` | **0** | — | 0 / 0 |

- 与上一轮独立计数**完全一致**（284 / 67 / 7），说明字符串层扫描稳定可信；
- **`offset=1405810` 处 ±512 B 窗口内同时出现 `AppleMusicWin` 与 `AMPLibraryAgent`** → 这是"包级记录"的强线索
  （但按你的边界：**邻近只作 SQLite 页/记录结构线索，不证明同一条记录**）；
- `.srd-wal`(6,464 B) 与 `.srd-shm`(32,768 B) 里 **6 个 token 全为 0** → 这两个文件里**没有**本次关心的事务/索引痕迹；
- `ClassId = 0` 很值得注意：manifest 里明明是 `<ProxyStub ClassId="F707A913-…">`，而 StateRepository 的
  可扫字符串里**没有 `ClassId` 这个键名** → 说明它的存储形态不是"键名+值"的文本，而是 schema 化的列（或 BLOB）。

## 3. 与上一轮合并后，仍然可靠的结论

1. `proxyStub` 在 StateRepository 中出现 **284** 次 → **packaged-COM 扩展类别确实被记录**；
2. `AppleMusicWin`(67) + `AMPLibraryAgent`(7) → 包与代理 agent 的相关行存在；
3. **但直接 GUID 级关联（IID / PS CLSID）尚未被证明**——字符串扫描对 BLOB 天然无效，而本轮字节扫描又因 bug 无效。

因此正确措辞仍然是（你给的版本）：

> **StateRepository contains packaged-COM extension metadata, but direct GUID-level linkage has not been demonstrated.**

## 4. 下一轮（一步即可决定性，脚本已定位到唯一改动点）

1. 修 `PatBytes`（`ToByte` + ASCII 直用字符串）→ 对**同一份副本**重跑 4 种 GUID 字节表示：
   - `F707A913…` LE `13 A9 07 F7 CE E0 D4 4F BC E3 42 5D D1 53 28 5B`、BE `F7 07 A9 13 E0 CE 4F D4 …`
   - `68E7097C…` LE `7C 09 E7 68 69 F9 06 40 AA C3 95 11 5F 0E D1 C4`、BE `68 E7 09 7C F9 69 40 06 …`
   - 命中则取 ±200 B hex + 可见字符串；
2. 对 `proxyStub` 的 284 个 offset **全部**做 ±512 B 邻居统计（本轮只看了前 3 个），检查是否出现
   `AppleMusicWin` / `AMPLibraryAgent` / GUID 字节 / `Path` 类字段；
3. 命中 → 进入 SQL 级解析（此时目标明确，值得准备只读 sqlite 能力）；
   全部为空 → 才写"该映射未以这些形式存在于该副本"，并维持
   **`OS_PACKAGE_COM_REGISTRATION_PATH_UNRESOLVED → PRACTICALLY CLOSED`**，不再碰 `vtable[3+]`。

## 5. 纪律

业务方法 **0**｜`vtable[3+]` **0**｜代理 DLL 加载 **0**｜PS 注册调用 **0**｜注册表写入 **0**｜输入模拟 **0**｜
前台切换 **0**｜包注册净变化 **0**｜ACL/owner 修改 **0**｜**提权 0 次（本轮复用上一轮副本）**｜副本**只读未改**。
另：上轮记录的 `ELEVATED_PROCESSES_STILL_RUNNING=2` 仅作观察保留——**未杀进程、未扩大实验面**；
若要核对，只做 PID/ParentPID/CommandLine/User/IntegrityLevel/StartTime 的只读查询。

验收条件继续有效：`mouseMoved=false`、`keyboardInjected=false`、`foregroundChangedByApplication=false`、`SMTC changed = expected`。
UIA 线维持归档：`UIA_PLAYBACK_ACTIVATION_CONTRACT = UNAVAILABLE`。
