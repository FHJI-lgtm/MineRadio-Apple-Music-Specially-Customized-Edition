# 3D 专辑墙 · 独立原型

> 独立原型，不改 MineRadio 资料库组件。打开：`http://127.0.0.1:3000/lab/3d-album-wall/index.html`
> 数据：`/api/apple/library/index`（真实 Apple Music 封面）。

## 空间模型（按验收说明实现）

每张专辑是一块 **w × h × t** 的薄板（w = 1000 纵深、h = 430 高、t = 44 厚），
**绕 Y 轴转 90°** 垂直站立，沿 X 轴排成一排。镜头正对，一点透视，
**消失点在屏幕中央**（`perspective-origin: 50% 50%`）。

```
薄板中心:  x = (i − pos) · 96px,  y = 235 − 430/2 = 20,  z = −1000/2 = −500
变换:      translate3d(x, y, z) rotateY(90deg)
近边落在 z = 0 平面，向纵深退到 z = −1000（透视 scale 0.47）
```

于是：**中间的薄板只剩 44px 书脊可见，越往两侧越能看到封面正面** —— 这来自投影几何，
不是逐张调角度，也不是 carousel。

## 六个面

| 面 | 变换 | 材质 |
|---|---|---|
| 正面（+X） | `translateZ(t/2)` | 封面 |
| 背面（−X） | `rotateY(180deg) translateZ(t/2)` | 封面（水平镜像，保证两侧都能看到封面正面） |
| 书脊（+Z，朝向镜头） | `rotateY(-90deg) translateZ(w/2)` | 封面主色底 + 竖排粗体白字 |
| 远端薄边 | `rotateY(90deg) translateZ(w/2)` | 纸边 |
| 上下薄边 | `rotateX(±90deg) translateZ(h/2)` | 纸板窄边 |

## 书脊

- 文字：`专辑名 · 艺人`，`writing-mode: vertical-rl` + `rotate(180deg)` → **自下而上**阅读，粗体白字；
- 底色：封面主色。经 `/api/cover?url=` 代理（带 `Access-Control-Allow-Origin: *`）后 canvas 采样 6×6 平均色，
  过滤过亮/过暗像素；取色失败时回落到深色底。

## 倒影与景深

```
倒影: 同一几何体 translate3d(x, 2F − y, z) rotateY(90°) scaleY(-1)   // F = 地板线 235
       opacity .50 + blur 1.6px + 由下向上渐隐遮罩
景深: d = |x|;  light = 1 − min(1, d/900) · 0.52
              blur  = clamp((d − 200) / 230, 0, 4.2) px
```

## 交互

- 左右滑动：真实鼠标/触摸拖拽，按事件间隔归一化速度 → **惯性滑行** → 减速后 **吸附到最近一张**；
- 滚轮 / `←` `→` 也可切换；
- 顶部 Liquid Glass 胶囊分段控件：`backdrop-filter: blur(24px) saturate(1.6)` + 1px 高光描边 + 内阴影。

## 验收自检

| 条件 | 结果 |
|---|---|
| 薄板垂直屏幕、一点透视、消失点居中 | ✅ 全部 `rotateY(90deg)`，`perspective-origin: 50% 50%` |
| 中间只露书脊、两侧露封面 | ✅ 投影几何直接产生 |
| 书脊竖排粗体白字、自下而上、底色取封面主色 | ✅ 实测书脊底色为各封面平均色 |
| 地板倒影（镜像 + 渐隐 + 模糊） | ✅ 同几何体镜像副本 |
| 离中心越远越模糊越暗 | ✅ 按 \(|x|\) 计算 light/blur |
| 左右滑动惯性 + 吸附 | ✅ 拖动改变位置，release 后惯性 + `Math.round` 吸附 |
| Liquid Glass 顶部分段控件 | ✅ `backdrop-filter` + 高光描边 |
| 无调试文字 | ✅ 页面只有悬浮控件 |
| 真实 Apple Music 封面 | ✅ |

调试读数（仅用于验收，不影响画面）：控制台执行 `window.__labState()` 可读当前 `pos / velocity / count`。
