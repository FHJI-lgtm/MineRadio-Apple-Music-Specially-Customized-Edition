# MineRadio「音乐资料库 / Music Library」页面设计规范

> 状态：**设计定稿提案（Phase 0，只做设计，不改代码）**
> 目标页面：独立的 `音乐资料库`（Music Library）
> 第一阶段数据源：Apple Music Library
> 未来数据源：MineRadio 内部（QQ 音乐 / 酷狗 / 网易云）与更多来源

---

## 0. 前提与边界

### 0.1 不动的部分

| 现有资产 | 位置 | 处理方式 |
| --- | --- | --- |
| 首页「音乐库」卡片 | `public/index.html:190-196`，`onclick="openHomeDashboardLibrary()"` | **语义完全不变**。它继续负责"直接打开歌单/本地/已登录平台"，不承接 Apple Music 资料库 |
| 顶部搜索栏 | `#search-area` / `#search-box`（`index.css:1694`、`1732`） | 原控件原样复用，只作为浮层 |
| Mini Player | `#bottom-bar`（`index.html:1257`、`index.css:5011`） | 原控件原样复用，只作为浮层 |
| 播放/搜索逻辑 | — | 不修改 |

### 0.2 顶层导航关系（P1-Nav 先定死，优先于页内设计）

> 本节定义的是**页面之间的导航关系**，不是 Library 页面的内容。**P1-Nav 阶段先只做这一节**，Library 内部细节（最近添加、专辑墙、歌曲列表…）一律等导航关系确认顺眼之后再填。

#### 信息架构

```
主页 Home
   │
   ├── 🎵 音乐资料库 (Music Library)
   │       └── Apple Music Library          ← Phase 1 唯一资料源
   │
   ├── 音乐库 (现有卡片，openHomeDashboardLibrary)
   │       └── 现有歌单入口                  ← 语义完全不变
   │
   └── 其他首页功能
```

**「主页」与「音乐资料库」是同级页面，不是主页里的一个内容区。** 这条是整个导航设计的基准，任何「把资料库塞进首页某个容器」的做法都算违规。

##### 入口关系（两个「库」彻底分开）

```
                    ┌──────────────┐
                    │    Home      │
                    └──────┬───────┘
                           │
              ┌────────────┴────────────┐
              ↓                         ↓
       现有「音乐库」              「音乐资料库」
       （保持不动）                    │
              │                        ↓
            歌单                 Apple Music 资料库
                                （QQ / 酷狗 / 网易云后续接入）
```

故意分成两条互不相交的路：

- **主页里的「音乐库」**：原来的职责 —— 点进去就是歌单，完全不碰；
- **顶部「音乐资料库」**：新的一级工作区，负责将来 Apple Music / QQ / 酷狗 / 网易云等资料聚合；
- **`#home-btn`**：现成的 Home 返回入口，不新增巨大返回按钮；
- **`#mlib-nav`**：只负责在 Home ↔ 音乐资料库之间切换。

##### viewport 结构

```
viewport
├── #search-area            ← 既有，不动
├── #mlib-nav               ← 新增，独立 fixed 导航锚点（不属于 #top-right）
├── #top-right              ← 既有的账号胶囊容器，原样保留
│   └── #home-btn           ← 原样保留，继续当 Home 返回入口
└── #music-library-scroll   ← 后续资料库页面
```

> **`#top-right` 不应该承担全局导航职责**：它是账号胶囊自动隐藏（`--96px` 飞出屏幕）的作用域。持有全局导航的容器不能被这个机制拖走，所以 `#mlib-nav` 必须是它的**兄弟节点**，而不是子节点。

> 注意区分两个中文名，它们是完全不同的东西：
>
> | 名称 | 职责 | 入口 | Phase 1 是否改动 |
> | --- | --- | --- | --- |
> | **音乐库** | 直接打开歌单 / 本地 / 已登录平台 | 首页 `home-card`（现有） | ❌ 完全不改 |
> | **音乐资料库** | 独立工作区，Phase 1 接 Apple Music Library | 新增顶部导航项 | ✅ 新建 |
>
> 两者不要混淆，也不要合并入口。

#### 顶部导航线框

```
┌──────────────────────────────────────────────────────────────────────┐
│  ┌──┐                                                                │
│  │♪ │   ┌──────────────────────┐                    ↑        ⌂   👤  │
│  └──┘   │  ⌕  搜索歌曲、歌手... │                上传钮              │
│  #mlib-nav └──────────────────────┘                                  │
│   左侧 · 独立                                                         │
└──────────────────────────────────────────────────────────────────────┘

Home 状态：        ♪ (未激活)                  ⌂ (ACTIVE)
资料库状态：       ♪ (ACTIVE)                  ⌂ (未激活)
```

##### 是「同一级别的第二个图标入口」，不是「带名字的工作区胶囊」

这是本阶段最容易做歪的一点。正确的心智模型是「MineRadio 全局导航里多了一个按钮」，而不是「Library 页面挂了个标题」：

| ❌ 不要 | ✅ 要 |
| --- | --- |
| 「图标 + 名称」的胶囊（🎵 音乐资料库） | 与 `#home-btn` 同款的 44×44 纯图标按钮 |
| 大号带页面名的主标题按钮 | 与搜索栏同一视觉量级的圆形玻璃钮 |
| 只在 Library 页出现（像页面自己的标题） | 在 Home 与 Library **都常驻**，two-way 可达 |
| 用字号 / letter-spacing 等一套新样式 | 零新增视觉语言，完全复用既有 `.icon-btn` |
| 加「← 返回」箭头表示层级 | 两个平级图标的 active 态表示「我在哪个工作区」 |
| 靠文字表达身份 | 靠图标语义（音乐符号 vs 房子）+ title / aria-label + active 态 |

未来要扩成更多工作区时，只需在 `#mlib-nav` 里再加一个同款图标按钮 —— 结构不变，视觉也已经天然对齐。


进入资料库后：

```
Home
  ↓
音乐资料库
┌──────────────────────────────────────────────────────────────────────┐
│  🔍 搜索                                                              │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│                        音乐资料库                                     │
│                        Apple Music                                   │
│                                                                      │
│                        （P1-Nav 阶段留空）                             │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│                    Mini Player / Controls                            │
└──────────────────────────────────────────────────────────────────────┘
```

导航状态：

```
Home 页                        音乐资料库页
◎ 音乐资料库  ← 未激活          ◉ 音乐资料库  ← active（主色描边 + glow）
◉ Home       ← active           ◎ Home       ← 未激活

（◎ = .icon-btn 默认态；◉ = color:#fff + 主色描边 + 淡底 + glow + aria-current="page"）
```

#### 三个元素的去向

| 元素 | 处理 |
| --- | --- |
| 现有 `#home-btn`（`index.html:315`，`onclick="goHome()"`） | **保留**，继续作为明确的 Home 返回入口。`#top-right` 本来就常驻，不需要新建"← 返回主页"大按钮 |
| 新增 `#music-library-btn` | 新建，`onclick="openMusicLibrary()"`，进入资料库 |
| 现有首页「音乐库」卡片 | **完全不改**，继续走 `openHomeDashboardLibrary()` |

#### 实现铁律

1. **导航组必须锚定在视口，不能放进 `#top-right`**

   既有规则 `body.user-capsule-auto-hide #top-right { right: -96px; visibility: hidden }`（`index.css:3733`）会让 `#top-right` 整组飞出屏幕。如果导航组是它的子元素，自动隐藏模式下两个页面**都无法互相到达**。

   ```css
   ```css
   /* ✅ 正确：独立锚定在左侧 + z-index 10，与 #search-area / #top-right 同级 */
   :root { --mlib-nav-left: 24px; }
   #mlib-nav {
     position: fixed;
     z-index: 10;
     left: var(--mlib-nav-left);
     top: 31px;                /* 53px 搜索框中线 - 22px 按钮半高 */
     -webkit-app-region: no-drag;   /* 否则点击会被 #desktop-titlebar 的拖拽吃掉 */
   }
   #top-right {
     /* 原代码完全不动 —— 尤其这两条： */
     /*   top: 24px; right: 24px;                        */
     /*   body.user-capsule-auto-hide #top-right { ... }  */
   }
   ```

   `#mlib-nav` 与 `#top-right` 是**兄弟节点**，入口锚在视口左侧，**不改变 `#top-right` 自身的显隐逻辑**。因为 `#mlib-nav` 不属于它，自动隐藏时自然不会被一起拖走。

   > **为什么放左侧（P1-Nav 落地后按实机反馈调整）**：搜索框右侧已被上传按钮与账号胶囊占满，入口放那里既挤又没人会去找。左侧是空的，且与右下角的 Home 入口分居两端，职责更清楚。
   >
   > 附带好处：入口位置从此是**常量**，不再依赖 `#top-right` 的实测宽度。早期方案曾按 `#top-right` 实宽（胶囊展开时 272px）动态计算右侧锚点，入口移到左侧后这套运行时测量被整体删除。
   >
   > **≤720px**：搜索栏几乎贴到视口左边（`left ≈ 14px`），入口下移到搜索栏下方（`top: 128px`），两者都保持完全可用。
   >
   > **⚠️ 两个必踩的坑**：`#desktop-titlebar` 覆盖 `0–44px` 且是 `-webkit-app-region: drag` 拖拽区，入口必须显式 `no-drag`，否则点击会被窗口拖动吃掉；同时 `top` 必须让按钮与搜索框共用中线（`31px`），否则视觉上会和搜索框错位。
2. **不用自定义路由。** MineRadio 是 Electron 渲染层，没有 router，也没有任何 `history.pushState` 的使用。页面状态继续用既有 body class 表达：
   - Home 页：`body.empty-home-active`
   - 资料库页：`body.music-library-active`

3. **`#home-btn` 的显隐绝不改动。** 它现在**一直可见**（`#top-right` 常驻，无任何 show/hide 规则，JS 零引用），并且已是主色描边按钮。不要去"让它在 Home 页隐藏"。

4. **`goHome()` 不改。** 资料库关闭时只需移除 `body.music-library-active`，Home 的自然可见性由既有逻辑接管。

5. **导航在沉浸模式下随既有规则一起隐藏**（`body.immersive-mode` 会隐藏 `#search-area` / `#top-right`）。资料库是工作区而非全屏视觉状态，这个行为是对的。

#### 目标 DOM（P1-Nav 增量）

**关键决定 1（上一版）：`#home-btn` 留在 `#top-right` 内，一字不动。**

原因：`#home-btn` 的既有样式被 `#top-right .icon-btn` 与 `#user-btn.multi-account` 的组合规则成组命中（`index.css:15530`、`15743`），把它搬进新容器会连带影响账号胶囊那套布局；而且它本身不是风险点，没有搬的理由。

**关键决定 2（本版）：入口为纯图标按钮，不显示「音乐资料库」文字。**

`#music-library-btn` 与 `#home-btn` 是**同一级别的两个独立图标入口**，视觉上直接复刻 `#home-btn` / `.icon-btn` 的既有体系，而不是新造一套 Library 专属 UI：

```
      #mlib-nav                 #top-right
   ┌──────────────┐        ┌──────────────┐
   │      ◎       │        │      ⌂       │
   │  Library     │        │    Home      │
   └──────────────┘        └──────────────┘
     纯图标按钮                既有 #home-btn
     （44×44 圆形）             （44×44 圆形，一字不改）

⚠️ 不再是「图标 + 名称」的胶囊。文字只存在于 title / aria-label 里，不出现在界面上。
```

##### 为什么这比文字胶囊更对

| 文字胶囊版（已废弃） | 纯图标版（本版） |
| --- | --- |
| `#mlib-nav` 是一个玻璃胶囊容器，内含「🎵 + 音乐资料库 + active 描边」 | `#mlib-nav` 退化为很薄的定位壳，只负责锚定与位移 |
| 视觉上要「假装」和 `⌂` 成组（结构上却是两个容器） | 两个按钮各自独立 `.icon-btn`，**结构与视觉天然同级** |
| 读起来像网页后台的 workspace switcher | 读起来就是 MineRadio 自己的全局导航按钮 |
| 需要 `mlib-nav-label`、字号、letter-spacing 等一套新样式 | 零新增视觉语言，完全复用既有 `.icon-btn` |

> **这就是「跟 MineRadio 自己的 Home 一样」的落地方式**：新入口成为 MineRadio 原有导航体系的一员，而不是 Library 专属 UI。

##### 目标 DOM

```html
<!-- 新增：独立导航锚点。很薄的定位壳，只装一个纯图标按钮 -->
<nav id="mlib-nav" aria-label="工作区导航">
  <button id="music-library-btn" class="icon-btn" type="button" onclick="openMusicLibrary()"
          title="音乐资料库" aria-label="音乐资料库">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 18V5l12-2v13"/>
      <circle cx="6" cy="18" r="3"/>
      <circle cx="18" cy="16" r="3"/>
    </svg>
  </button>
</nav>

<!-- #top-right 内的既有 #home-btn：DOM / 样式 / onclick 全部原样保留，一字不改 -->
<!-- 唯一允许的改动：补一个 aria-current，纯无障碍语义，对视觉零影响 -->
<button id="home-btn" class="icon-btn" onclick="goHome()" title="回到 Home"
        aria-label="回到 Home" aria-current="page">…</button>
```

`#music-library-btn` **直接带 `.icon-btn`**（`index.css:3425`：44×44、圆角 50%、1px 描边、blur(20px)），所以它天然就是 `#home-btn` 的同级兄弟。

##### 四条一句话架构（本设计的核心，P1-Nav 之后不应被推翻）

```
DOM：独立          两个按钮不互为父子，各在自己的容器里
视觉：同级          同款 .icon-btn，尺寸/圆角/玻璃完全一致
定位：几何对齐      入口锚在视口左侧的常量位置，不依赖任何邻居宽度
职责：互不干扰      账号胶囊自动隐藏波及 #top-right，但碰不到 #mlib-nav
```

**为什么不去追求「DOM 也对称」**：`#top-right` 内的 `#home-btn` 已被一整套历史选择器依赖（`#top-right .icon-btn` / `#user-btn.multi-account` / `account-pill-stack`）。为了 DOM 形式上的对称把它硬搬出来，是在制造没有必要的回归风险。**DOM 独立 + 视觉同级 + 几何对齐 + 职责互不干扰**，比强行让两个按钮成为兄弟节点更合理。

##### 导航样式（几乎不新增视觉语言）

```css
/* 很薄的定位壳：不动玻璃、不动尺寸，视觉全部交给 .icon-btn 与 #music-library-btn */
#mlib-nav {
  position: fixed;
  z-index: 10;
  left: var(--mlib-nav-left);
  top: 31px;                              /* 与搜索框共用中线 */
  -webkit-app-region: no-drag;            /* 退出 #desktop-titlebar 的拖拽区 */
  align-items: center;
}

/* 唯一新增的视觉语言：active 态。其余全部继承 .icon-btn，与 #home-btn 同级同款 */
body.music-library-active #music-library-btn {
  color: #fff;
  border-color: rgba(0, 245, 212, .62);
  background: rgba(0, 245, 212, .10);
  box-shadow: 0 0 20px rgba(0, 245, 212, .16);
}

/* ⚠️ 不新增 body.empty-home-active #home-btn 规则 —— 那条已经存在（index.css:3774、15960），
   且已被后面的 !important 规则统一成主色；再加一条只会制造级联冲突。
   Home 的 active 态由既有规则 + aria-current 表达，本页对它的 CSS 零改动。 */
```

##### active 态只靠形状与光，不靠文字

```
Home 页：          [ ◎ ]        [ ◉ ]         ← 音乐资料库未激活 / Home 激活
资料库页：         [ ◉ ]        [ ◎ ]         ← 音乐资料库激活 / Home 未激活

◉ = color #fff + 主色描边 + rgba(0,245,212,.10) 底 + 主色 glow + aria-current="page"
◎ = 既有 .icon-btn 默认态（弱描边、低透明度图标）
```

用户不需要读任何文字，就能知道当前在哪个工作区。文字信息由 `title` 与 `aria-label` 承担，读屏由 `aria-current="page"` 承担。

> **没有 `aria-current` 时的降级**：激活态在视觉上已由 `body.music-library-active` 纯 CSS 表达，不依赖 JS 补属性；`aria-current` 只是让「我在哪」对读屏同样成立。

#### 水平空间预算（防重叠）

```
                                        viewport
  ┌────────────────────────────────────────────────────────────────────────┐
  │ ┌──────────┐        ┌───────────────┐        ┌───────────────────────┐ │
  │ │ #mlib-nav│        │ #search-area  │        │     #top-right        │ │
  │ │    ♪     │        │ ⌕ 搜索...     │        │ 上传  ⌂  👤           │ │
  │ └──────────┘        └───────────────┘        └───────────────────────┘ │
  └────────────────────────────────────────────────────────────────────────┘
    ↑ 独立 fixed          ↑ 既有                 ↑ 既有，一字不改
      锚定视口左侧
```

```
left: 24px（常量，不随任何邻居变化）
  #mlib-nav 右边缘 = 24px + 44px = 68px
  搜索栏左边缘（居中布局）：min(620px, 100vw-56px) 居中后，两侧各有大片留白

  → 入口与搜索栏之间的空隙随视口宽度自然增大，任何宽度下都不会相撞
  → 不再需要为 #top-right 的宽度（账号胶囊展开时实测 272px）做任何让位计算
```

```css
:root { --mlib-nav-left: 24px; }
#mlib-nav {
  position: fixed;
  z-index: 10;
  left: var(--mlib-nav-left);
  top: 31px;                     /* 53px 搜索框中线 - 22px 按钮半高 */
  -webkit-app-region: no-drag;   /* #desktop-titlebar 覆盖 0-44px 且是拖拽区 */
}
```

> 入口移到左侧后，早期那套「实测 `#top-right` 宽度 → 动态计算右侧锚点」的实现被**整体删除**：左侧是常量，不需要运行时测量，也就没有了动画期间读到旧布局的风险。

#### 入口的抽象层级（决定它以后能长成什么）

这个入口已经足够抽象：**它不是「Apple Music 按钮」，甚至也不只是「音乐资料库按钮」，它就是 MineRadio 的另一个工作区入口。**

```
现在：  [ ◎ ]  [ ⌂ ]
        Library  Home

以后：  [ ◎ ]  [ ⌂ ]  [ ♪ ]  [ ⚙ ]
        Library  Home  Radio  Settings
```

新增工作区时只需往 `#mlib-nav` 里再加一个同款 `.icon-btn`，**不用重新设计导航语言**。这也是为什么入口不带文字：带文字会把每个工作区锁定成一个特定的中文名，反而限制了它的抽象层级。

#### 状态源是一条链，不是一个状态机

```
body.empty-home-active   → Home 按钮 active
body.music-library-active → Library 按钮 active
```

**单向：页面在哪 → body 是什么状态 → CSS 怎么表现。**

```css
body.music-library-active #music-library-btn { ... }   /* 只看 body */
```

❌ 明确禁止这种写法（UI 状态最容易变成屎山的地方）：

```js
// 给 A 加 active、给 B 删 active、某个事件又给 A 加回来……
$$('#music-library-btn').classList.add('active');
$$('#home-btn').classList.remove('active');
```

导航的 active 态**不得由 JS 切 class**。页面状态本来就只有一个真相源（body class），再引入一套 JS 状态就是两个真相源。

#### P1-Nav 验收：核心条件 + 附加回归

核心条件（三条，缺一不可 —— 一件不过就不往下走）：

| # | 验收项 | 必须成立 |
| --- | --- | --- |
| **1** | **新入口** | 常驻、稳定、可点击。启动 / 回首页 / 播放器展开收起都不影响它 |
| **2** | **Home ↔ Library** | 双向切换正常；active **互斥**；**Home 原有状态不被破坏**（布局与滚动位置与进入前一致） |
| **3** | **胶囊自动隐藏** | `#top-right` 飞走时，Library 入口仍**完全正常**（原位、可点、往返链路不断） |

附加回归（同批检查）：

| # | 回归项 | 必须成立 |
| --- | --- | --- |
| **R1** | ≤720px 布局 | 入口下移到搜索栏下方（`left: 14px; top: 128px`），**不与搜索栏重叠** |

> **实现期修正（P1.0 实测）**：`--mlib-safe-bottom-idle` 不能取 96px。播放器 bar 高约 99px + 底边距 16px ≈ 115px，96px 会让最后一行内容落进播放器底下。实测在 621px 高的窗口里滚到底后卡片仍差 15px 被压住，改为 **132px** 后余量为 21px。安全区必须覆盖浮层的真实占用，而不是一个看起来合理的整数。
| **R2** | 原「音乐库」卡片 | **完全不动** —— 行为与改动前逐字节一致（只新增，不改动既有节点） |

这三条核心条件通过以后，才进入 **Library 空壳**（P1.0），再往里面填 Recently Added 与专辑墙。

---

#### ✅ P1-Nav 实现状态（已落地并验证）

| 项 | 状态 |
| --- | --- |
| 实现文件 | `public/js/modules/10-shell/06-music-library.js`（单个扁平模块）、`public/index.html`、`public/css/index.css` |
| 既有文件改动 | 仅 **+1 行** 各：`index-loader.js`（注册模块）、`04-home-empty-wallpaper.js`（`shouldShowEmptyHomeCore` 护栏）、`02-preferences-ui-modes.js`（胶囊切换后重算锚点） |
| 契约测试 | `tests/music-library-shell.test.js` — 全部通过 |
| 运行时验证 | `scripts/check-music-library-shell-live.js` — **47/47 通过**（真实 Electron 渲染器 + CDP） |
| 截图 | `docs/assets/music-library/01-home.png`、`02-music-library.png`、`03-recently-added-real.png`（真实数据） |

**P1.0 已完成（最近添加轨道）**

| 项 | 内容 |
| --- | --- |
| 数据 | `GET /api/apple/library/albums?limit=30&offset=0` → 实测 200，`total=549`，`sortedBy=dateAdded/desc` |
| 渲染 | `mlib-recent-rail` 横向轨道，30 张卡片，真实 Apple 封面（mzstatic），歌手 · 年份 |
| 前端排序 | **没有**。严格按接口返回顺序渲染；模块内注释明确禁止加 sort |
| 实测证据 | 30 张卡片 / 30 个 `<img>` / 封面自然加载 / 首条 `SPIN - Single`（Kroi · 2026） |

实现期发现并修正的三个真实问题（值得记下来，都不是设计问题而是落地细节）：
实现期发现并修正的真实问题（都不是设计问题，而是落地细节）：

1. **入口一开始放在右侧，实机反馈「没人会去搜索框旁边找」**。搜索框右侧已被上传按钮与账号胶囊占满，入口挤在中间既难发现也难点击。改为锚定视口**左侧**后：位置变成常量，运行时测量被整体删除，与搜索框的间距随视口自然增大。
2. **`#top-right` 实测宽 272px**，远大于早期估算的 156px（账号胶囊 + hide 按钮都占位）。这是右侧方案被放弃的另一个原因：任何写死像素值或依赖实测宽度的做法都会在窄屏上直接重叠（实测重叠过 84px）。
3. **`#desktop-titlebar` 覆盖 `0–44px` 且是 `-webkit-app-region: drag` 拖拽区**。入口放在左上后必须显式 `no-drag`，否则点击会被窗口拖动吃掉 —— 这是「能看见但点不动」的隐蔽故障。
4. **`goHome()` 是切换语义**（`emptyHomeActive` 为 false 时它走 `homeForcedOpen` 分支而收起首页），不能直接用作出库返回。做法是在 `#home-btn` 上挂**捕获阶段**监听：先关掉资料库，再让 `goHome()` 原有逻辑跑 —— 既不改 `goHome()`，也不给它打补丁。

另外记录一处**观察到的视觉后果**（不是 bug）：`#top-right` 在多层账号状态下会改为 `align-items: flex-start`，此时 Home 按钮与账号胶囊上下错位（见 `01-home.png`）。这是既有布局在多账号下的形态，且 `⌂` 按铁律 2 保持原地不动，P1-Nav 不介入。

---

### 0.3 ⚠️ Phase 1 实现护栏（优先于本文档任何"扩展点"）

> **本文档是 UI/UX 规格书，不是架构授权书。所有标着"扩展点 / 未来 / Provider"的内容，都是给视觉预留空间的，不是 Phase 1 的施工图。**

Phase 1 的实现链路只允许有这么长：

```
        UI（本规格书描述的那一层）
         ↓
   Apple Music Library
         ↓
   现有 AM 数据能力
```

**不允许**在 Phase 1 出现下面这条链：

```
UI
 ↓
Provider abstraction        ← ❌ 第一版不做
 ↓
Source registry             ← ❌ 第一版不做
 ↓
Capability system           ← ❌ 第一版不做
 ↓
Apple Music adapter         ← ❌ 第一版不做（能力直接从现有调用点取）
 ↓
……
```

理由不是"抽象不好"，而是**排序**问题：滚动手感、安全区、mask 收边、三明治层次这些才是这次页面的风险所在，它们必须先在真实数据下被验证。如果在只有一个数据源的时候就把多来源抽象做出来，接下来必然变成：

> "为了未来 QQ/KG/NE 扩展，我们先重构一下架构。" → token 原子弹式裂变 → 页面手感一天都没被真正验证过。

**正确顺序：Apple Music 打通 → 验证滚动手感 → 再抽象多来源。**

#### 明确允许 / 明确禁止（Phase 1）

| ✅ 允许 | ❌ 禁止 |
| --- | --- |
| 一个扁平的 `mlib-*` 模块直连现有 Apple Music Library 能力 | 引入 `LibraryProvider` 接口 / 目录 / 工厂 |
| 渲染函数直接按数据有无决定"渲染哪个分区" | 引入 source registry、能力表、动态 provider 解析 |
| 在模块顶部用一句注释标注将来该抽哪一处（见下） | 把"未来扩展"写成现在必须完成的 TODO |
| 来源 chip 在视觉上保留位置，Phase 1 只渲染 Apple Music 一项 | 为了适配未来的第二种来源，提前泛化分区渲染器 |

#### 抽象窗口的标注方式

不写代码抽象，只在**唯一那个会变的地方**留一句注释，作为未来抽出的锚点：

```js
// ABSTRACTION SEAM (Phase 2): 这里是 UI 与数据源之间唯一的变化点。
// 当第二个来源落地时，把本函数抽成 provider.fetchSection(section, cursor)。
async function mlibLoadSection(section, cursor) { /* 直连 Apple Music */ }
```

**"只有一个 seam，且它是一个函数"** 就是 Phase 1 的抽象上限。这个 seam 的存在感应当低到：即使最终决定不做多来源，删掉它也不心疼。

#### 判定自己是否越线的三个问题

1. 我是否新建了只有一个实现的接口/基类/注册表？→ 越线。
2. 我是否为了"以后可能有的来源"而修改了分区渲染逻辑？→ 越线。
3. 我现在能不能在**不改任何结构**的前提下，把一个真实的 Apple Music 专辑渲染到最近添加轨道里？→ 能，才算在正轨上。

---

### 0.4 两个入口的分工（主入口 = 顶部导航）

**主入口是 0.2 节的顶部导航项**，不是首页卡片。导航项承担 "Home ↔ Library" 的往返切换，在任何页面都可达。

首页卡片是**次入口（可选，P1-Nav 阶段不做）**—— 它解决的是"用户从首页出发时，能在快速入口区一眼看到资料库"。但现在就做它，等于在导航关系还没被验证之前先往 Home 的既有网格里塞组件，顺序不对。所以：

- **P1-Nav**：只做顶部导航（0.2 节）→ 验证往返顺不顺；
- **P1-Nav 通过之后**再决定是否加下面这张卡片。

若届时仍要加，做法是在首页 `home-quick-grid` 中**追加**一张卡片，与现有四张并列（不动原有 DOM）：

```html
<!-- 新增，独立于 openHomeDashboardLibrary -->
<button class="home-card home-card-quick" data-home-tone="library"
        type="button" onclick="openMusicLibrary()">
  <div class="home-card-label">COLLECTION</div>
  <div class="home-card-title">音乐资料库</div>
  <div class="home-card-sub">Apple Music 与更多资料源</div>
  <div class="home-card-art"></div>
</button>
```

命名空间约定（避免与现有 `home-library-*` / `openHomeLibrary()` 冲突）：

| 类型 | 约定 |
| --- | --- |
| 根节点 id | `#music-library` |
| 滚动容器 | `#music-library-scroll` |
| 样式类 | `.mlib-*` |
| body 状态 | `body.music-library-active` |
| 入口函数 | `openMusicLibrary()` / `closeMusicLibrary()` |

---

## 1. 页面整体布局方案

### 1.1 核心思路：浮层 + 全页滚动，而不是"中间挖一个洞"

现状（`index.css:2233`）里 Home 是：

```css
#empty-home { position: fixed; top: 158px; bottom: 58px; ... }
body.empty-home-active.controls-visible #empty-home { bottom: 128px; }  /* 避让播放器 */
```

也就是说：**内容容器被上下硬切**，内容在 158px 处开始、在控制栏上方结束。这正是要避免的"矩形被裁掉"的感觉。

资料库页面改为：

- 滚动容器 **从视口顶部铺到底部**（`inset: 0`），视觉上没有任何被切出来的矩形；
- 只在**内部**留出 `padding-top` / `padding-bottom` 作为**静止时的安全区**；
- 内容滚动时**穿过**搜索栏与 Mini Player，由**遮罩渐变**自然收边；
- 搜索栏与 Mini Player 保持原有层级与玻璃质感，位置、尺寸、控件都不改。

### 1.2 层级（overlay 层级）

| 层 | z-index | 元素 | 说明 |
| --- | --- | --- | --- |
| L0 | 0 | `#custom-bg` / `#wallpaper-engine-layer` / `#canvas-container` | 背景与动态视觉，透出到玻璃层 |
| L1 | 1 | `#music-library-scroll` | 全屏滚动内容 + mask 渐变收边 |
| L2 | 4 | `.mlib-sticky-bar` 等 sticky 子元素 | 粘性元素（不脱离滚动容器） |
| L3 | 6 | `#bottom-bar` | **保持现状** |
| L4 | 10 | `#search-area` / `#top-right` / **`#mlib-nav`（新增）** | 顶层浮层。三者同级、互不嵌套（见 0.2 铁律 1），`#search-area` 与 `#top-right` **保持现状** |

> 关键：滚动容器 z-index **低于** 6 与 10，这样两个浮层永远压在内容之上，且**不需要给它们做任何改动**。

### 1.3 ASCII 线框 —— 桌面首屏

```
╔══════════════════════════════════════════════════════════════════════════╗
║  ┌───────────────────────────────────┐                                   ║
║  │  ⌕  搜索歌曲、歌手...              │        [All][NE][QQ][KG][QS]...   ║ ← L4 #search-area (固定)
║  └───────────────────────────────────┘                                   ║   top: 24px
╠══════════════════════════════════════════════════════════════════════════╣
║  ↓↓↓ 顶部 safe area 渐变（内容在此淡出）↓↓↓                          ▲    ║
║                                                                     │    ║
║   音乐资料库                                     ▓ 来源 ● Apple Music    ║ ← 页头
║   MUSIC LIBRARY                                                     │    ║
║   ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄        ║
║                                                                          ║
║   最近添加                                             查看全部 ›         ║
║   ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐   ┌────────┐            ║
║   │        │  │        │  │        │  │        │   │        │            ║
║   │  封面   │  │  封面   │  │  封面   │  │  封面   │   │  封面   │            ║
║   └────────┘  └────────┘  └────────┘  └────────┘   └────────┘            ║
║    专辑名      专辑名       专辑名      专辑名      专辑名                 ║
║    歌手        歌手         歌手        歌手        歌手                   ║
║                                                                          ║
║   ↓ 继续向下滚动出现：专辑网格 / 歌曲列表 / 艺术家 / 歌单                    ║
╠══════════════════════════════════════════════════════════════════════════╣
║  ↑↑↑ 底部 safe area 渐变 ↑↑↑                                          ║
║  ┌────────────────────────────────────────────────────────────────┐     ║
║  │ ━━━━━●──────────────────────────────────────────────────────── │     ║ ← L3 #bottom-bar
║  │  ▢  歌名 - 歌手      ◄◄  ▶  ►►   ☰     词    ♡   +            │     ║   (固定)
║  └────────────────────────────────────────────────────────────────┘     ║
╚══════════════════════════════════════════════════════════════════════════╝
```

### 1.4 ASCII 线框 —— 滚动中的"穿过"效果

```
滚动 Y = 0（停靠）            滚动 Y = 500（中段）           滚动 Y = 2400（尾部）
┌──────────────────┐          ┌──────────────────┐          ┌──────────────────┐
│  搜索栏（清晰）   │          │  搜索栏（清晰）   │          │  搜索栏（清晰）   │
│ ┄┄┄┄┄渐变┄┄┄┄     │          │ ┄┄┄┄渐变┄┄┄┄     │          │ ┄┄┄┄渐变┄┄┄┄     │
│ ▓▓ 模糊的专辑封面 │ ←穿过     │  最近添加         │          │  歌单卡片         │
│ （压低透明度）    │          │  ▓▓▓ 专辑墙 ▓▓▓   │          │  歌单卡片         │
│  最近添加         │          │  专辑 ······       │          │                  │
│  ┌────┐          │          │  歌曲列表         │          │  结尾留白         │
│  │封面 │          │          │  歌曲列表         │          │                  │
│  └────┘          │          │                  │          │                  │
│  专辑名           │          │ ┄┄┄┄渐变┄┄┄┄     │          │ ┄┄┄┄渐变┄┄┄┄     │
│ ┄┄┄┄渐变┄┄┄┄     │          │  ▓▓ 模糊的列表行  │ ←穿过     │  播放器（清晰）   │
│  播放器（清晰）   │          │  播放器（清晰）   │          │                  │
└──────────────────┘          └──────────────────┘          └──────────────────┘
```

---

## 2. 组件层级结构

```
（全局层，非 Library 专有）
├── #mlib-nav    ← 新增顶层导航组（0.2 节），fixed / z-index 10，
│                            与 #search-area、#top-right 同级，**不是 #top-right 的子元素**
├── #search-area          ← 既有，不动
└── #bottom-bar           ← 既有，不动

body.music-library-active
│
├── #music-library-scroll                    ← 全屏滚动容器（唯一 scroll 容器）
│   │   padding-top:    var(--mlib-safe-top)
│   │   padding-bottom: var(--mlib-safe-bottom)
│   │   scroll-padding-top/bottom 同值
│   │
│   ├── .mlib-glow                           ← 背景氛围光（跟随封面主色）
│   │
│   ├── header.mlib-page-head
│   │   ├── .mlib-eyebrow      "MUSIC LIBRARY"
│   │   ├── h1.mlib-title      "音乐资料库"
│   │   ├── .mlib-head-meta    统计摘要（如 "1,284 首 · 96 张专辑"）
│   │   └── .mlib-source-strip ← 【扩展点 A】数据源切换
│   │       ├── .mlib-source-chip.active   Apple Music      （Phase 1）
│   │       ├── .mlib-source-chip          MineRadio ▾      （Phase 2，分组）
│   │       │   ├── QQ 音乐 / 酷狗音乐 / 网易云音乐
│   │       └── button.mlib-source-manage  "管理来源"
│   │
│   ├── nav.mlib-section-nav                 ← 粘性分区导航（可选，Phase 1.5）
│   │      最近添加 · 专辑 · 歌曲 · 艺术家 · 歌单      +  A–Z 快速索引
│   │
│   ├── section.mlib-section[data-section="recently-added"]
│   │   ├── .mlib-section-head   标题 + "查看全部 ›"
│   │   ├── .mlib-rail           ← 横向滚动专辑墙
│   │   │   └── article.mlib-album-card.mlib-album-card--xl  × N
│   │   └── .mlib-skeleton-row   ← 加载骨架
│   │
│   ├── section.mlib-section[data-section="albums"]
│   │   ├── .mlib-section-head   + 排序（最近 / 名称 / 歌手 / 年份）
│   │   └── .mlib-album-grid
│   │       └── article.mlib-album-card  × N
│   │
│   ├── section.mlib-section[data-section="songs"]
│   │   ├── .mlib-section-head   + 视图切换（列表 / 紧凑）
│   │   └── .mlib-song-list
│   │       └── .mlib-song-row   # 封面 标题 歌手 专辑 时长 [❤] [⋯]
│   │
│   ├── section.mlib-section[data-section="artists"]
│   │   └── .mlib-artist-grid
│   │       └── article.mlib-artist-card  ◯头像 + 名称 + 专辑数
│   │
│   ├── section.mlib-section[data-section="playlists"]
│   │   ├── .mlib-section-head
│   │   └── .mlib-playlist-grid
│   │       └── article.mlib-playlist-tile  封面拼贴 + 名称 + 曲目数
│   │
│   └── footer.mlib-end-cap      ← 底部留白 + 结束标记
│
├── .mlib-edge-mask              ← 顶部/底部渐变遮罩（见第 4 节，pointer-events: none）
│
├── #search-area                 ← 既有，不动
└── #bottom-bar                  ← 既有，不动
```

**【扩展点 A】数据源切换**——**只预留视觉空间，Phase 1 不实现任何抽象**（见 0.3 护栏）。

```
Phase 1（现在）
  音乐资料库
  [● Apple Music]                         [管理来源]

Phase 2（未来，视觉已预留）
  音乐资料库
  [● Apple Music]  [○ MineRadio ▾]        [管理来源]
                       ┌─────────────────────────┐
                       │  MineRadio              │
                       │   ├ QQ 音乐      已登录  │
                       │   ├ 酷狗音乐     已登录  │
                       │   └ 网易云音乐   未登录  │
                       │  ─────────────────────  │
                       │  全部来源（聚合视图）    │
                       └─────────────────────────┘
```

> ⚠️ 上图里的 `[MineRadio ▾]`、登录态、聚合视图**在 Phase 1 一律不实现**。Phase 1 的 source strip 只渲染一个静态的 `Apple Music` chip —— 它的存在是为了让页头的视觉配重成立，不是占位一个待填的架构。
>
> 下面这段接口是**存档性质**的：记录的只是"未来抽象应该长什么样"，免得真到 Phase 2 时推翻重来。**它不是 Phase 1 的待办事项，也不构成任何实现授权**（见 0.3 护栏）。

若 Phase 2 真的到来，抽象目标大致是：

```ts
interface LibraryProvider {
  id: 'apple-music' | 'qq' | 'kugou' | 'netease' | ...
  label: string
  accent: string          // 复用 --source-qq / --source-netease 等既有 token
  capabilities: ('recentlyAdded' | 'albums' | 'songs' | 'artists' | 'playlists')[]
  fetchSection(section, cursor?): Promise<SectionPage>
  search?(query): Promise<...>        // Phase 2
}
```

届时页面可按 `capabilities` **动态渲染分区**：没有 `artists` 能力的来源就不渲染艺术家区，而不是渲染一个空区。

> **Phase 1 的对应做法**：不建能力表，渲染函数直接判断"这次拿到的数据里有没有 artists"，没有就不渲染该 section —— 同样的结果，零抽象成本。

---

## 3. 首屏视觉设计

### 3.1 首屏信息预算

**首屏只出现 2 个语义块**，绝不堆数据：

1. 页头（标题 + 来源标识 + 一句话统计）
2. 「最近添加」一行大封面（桌面 5 张，超出横向滚动）

在 1440×900 下，首屏可见高度约 900 − 24（搜索栏）− 130（播放器）= 746px，预算分配：

| 区块 | 高度预算 |
| --- | --- |
| 顶部安全区 | 128px |
| 页头 | 132px |
| 分区标题行 | 44px |
| 最近添加卡片（XL） | 约 300px（封面 236 + 文案 64） |
| 余量（露一点下一个分区标题） | 约 140px |

> 刻意让「专辑」的分区标题在首屏底部**露出一点点**，形成"下面还有内容"的滚动暗示。

### 3.2 页头

```
音乐资料库                          ← 34–44px / 700 / Noto Sans SC
MUSIC LIBRARY                       ← 10.5px / 800 / letter-spacing .18em
                                      色 rgba(255,255,255,.42)
1,284 首 · 96 张专辑 · 62 位艺术家    ← 12px / rgba(255,255,255,.55)
────────────────────────────────
[● Apple Music]  [MineRadio ▾]              ← 来源 chip，「●」用来源 accent 色
```

- **不使用**大字重 Hero 图，不使用 Apple Music 的红色渐变横幅；
- 标题左侧不加大图标，保持克制；唯一视觉重量来自下方第一行封面；
- 来源标识用"呼吸点 + 文字"，点用 `--home-accent`（`#00f5d4`）表示"已连接且在读"。

### 3.3 首屏质感层次（自下而上）

| 层 | 内容 | 参数 |
| --- | --- | --- |
| 1 | 背景（壁纸/视频/canvas） | 既有 `#custom-bg` / `#canvas-container` |
| 2 | 氛围光晕 `.mlib-glow` | 取当前封面主色，`radial-gradient`，`opacity: .16`，`filter: blur(90px)`，缓慢漂移 40s |
| 3 | 颗粒 `.mlib-grain` | 复用 splash 的噪声思路，SVG feTurbulence，`opacity: .035`，`mix-blend-mode: overlay` |
| 4 | 内容卡片 | 玻璃拟态（见第 7 节） |
| 5 | 边缘渐变 | 见第 4 节 |

> 与首页一致：背景**透出来**，而不是铺一层纯黑遮住。这是 MineRadio 的招牌观感。

---

## 4. 滚动安全区设计（重点）

### 4.1 为什么要"安全区 + 穿透"同时存在

| 需求 | 机制 |
| --- | --- |
| 正常停靠时内容不被搜索栏遮挡 | 滚动容器的 `padding-top` |
| 正常停靠时内容不被播放器遮挡 | 滚动容器的 `padding-bottom` |
| 快速滚动时允许穿过浮层 | 内容层 z-index(1) < 浮层 z-index(6/10)，且滚动容器**全屏**而非截断 |
| 不出现"矩形被裁掉" | 不做硬裁；用**渐变 mask** 让内容淡出 |
| 锚点定位不被遮挡 | `scroll-padding` + `scroll-margin` |

### 4.2 变量定义

```css
:root {
  /* 搜索栏：top 24 + 高度 58 = 82；再留 44 呼吸 → 126 */
  --mlib-safe-top: 126px;

  /* 播放器：bottom 16 + 约 96 高 + 上方留白 → 150；无播放器时 96 */
  --mlib-safe-bottom: 150px;
  --mlib-safe-bottom-idle: 96px;

  /* 渐变过渡带（内容在此区间内完成淡出） */
  --mlib-edge-feather: 56px;

  /* 内容左右边距 */
  --mlib-gutter: clamp(24px, 3.2vw, 56px);
}

/* 播放器隐藏（soft-hidden / home-controls-locked）时收紧底部安全区 */
body:not(.controls-visible) {
  --mlib-safe-bottom: var(--mlib-safe-bottom-idle);
}

/* 小屏收缩 */
@media (max-width: 760px) {
  :root { --mlib-safe-top: 104px; --mlib-safe-bottom: 132px; --mlib-edge-feather: 44px; }
}
```

> `--mlib-safe-bottom` 必须与既有 `body.empty-home-active.controls-visible #empty-home { bottom: 128px }`（`index.css:3338`）保持同一量级，避免首页与资料库的播放器避让不一致。

### 4.3 滚动容器

```css
#music-library-scroll {
  position: fixed;
  inset: 0;                         /* 全屏，绝不硬裁 */
  z-index: 1;                       /* < #bottom-bar(6) < #search-area(10) */
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;     /* 不把滚动传给背景 */
  -webkit-overflow-scrolling: touch;

  /* 停靠安全区 */
  padding: var(--mlib-safe-top) var(--mlib-gutter) var(--mlib-safe-bottom);
  box-sizing: border-box;

  /* 锚点/scrollIntoView 定位安全区 */
  scroll-padding-top: calc(var(--mlib-safe-top) + 8px);
  scroll-padding-bottom: calc(var(--mlib-safe-bottom) + 8px);

  /* 触底后的滚动贴齐手感 */
  scroll-snap-type: y proximity;
  scrollbar-width: none;
}
#music-library-scroll::-webkit-scrollbar { width: 0; height: 0; }
```

### 4.4 定位安全区：任何"滚动到某一项"都不会藏到控制栏下面

```css
/* 分区标题：滚动定位后停在安全区下方 */
.mlib-section-head {
  scroll-margin-top: calc(var(--mlib-safe-top) - 40px);   /* 标题贴在搜索栏下方 */
  scroll-snap-align: start;
}

/* 单曲/专辑：被 scrollIntoView 或键盘导航定位时，不被播放器压住 */
.mlib-song-row,
.mlib-album-card {
  scroll-margin-top: 96px;                     /* 顶部：不被搜索栏压 */
  scroll-margin-bottom: calc(var(--mlib-safe-bottom) + 16px);  /* 底部：不被播放器压 */
}

/* 末尾：保证最后一行能完整滚上来 */
.mlib-end-cap { height: 24px; }
```

配套的 JS 约定（实现期）：

```js
// 所有程序化滚动统一走一个入口，绝不使用裸 scrollIntoView()
function scrollLibraryTo(el) {
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
```

### 4.5 边缘渐变 / blur：用 mask，不用覆盖层

**为什么用 `mask-image` 而不是在浮层下面放一层 `linear-gradient`：**

- 覆盖层会在**浮层下面**，只能"盖暗"，无法让内容真正隐形；滚动到浮层缝隙处仍会看到硬边；
- `mask-image` 作用在滚动容器自身上，内容在过渡带内**按 alpha 淡出**，任何情况下都不出现矩形边；
- mask 属于滚动容器自己的绘制，**不会盖住搜索栏/播放器**——这两个浮层在 mask 之外（z-index 更高且不是它的子元素），保持绝对清晰。

```css
#music-library-scroll {
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0,
    rgba(0,0,0,.35) calc(var(--mlib-safe-top) - var(--mlib-edge-feather)),
    #000 var(--mlib-safe-top),
    #000 calc(100% - var(--mlib-safe-bottom)),
    rgba(0,0,0,.35) calc(100% - var(--mlib-safe-bottom) + var(--mlib-edge-feather)),
    transparent 100%
  );
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    rgba(0,0,0,.35) calc(var(--mlib-safe-top) - var(--mlib-edge-feather)),
    #000 var(--mlib-safe-top),
    #000 calc(100% - var(--mlib-safe-bottom)),
    rgba(0,0,0,.35) calc(100% - var(--mlib-safe-bottom) + var(--mlib-edge-feather)),
    transparent 100%
  );
}
```

**叠加的极浅氛围遮罩**（可选，增强"玻璃压住内容"的物理感，`pointer-events: none`）：

```css
.mlib-edge-mask {
  position: fixed;
  inset: 0;
  z-index: 5;                 /* 在内容(1)之上、播放器(6)之下 */
  pointer-events: none;
  background:
    linear-gradient(to bottom,
      rgba(3,6,8,.34) 0,
      rgba(3,6,8,.10) 74px,
      transparent 126px),
    linear-gradient(to top,
      rgba(3,6,8,.40) 0,
      rgba(3,6,8,.12) 96px,
      transparent 150px);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  mask-image: linear-gradient(to bottom,
      #000 0, #000 74px, transparent 126px,
      transparent calc(100% - 150px), #000 calc(100% - 96px), #000 100%);
}
```

> blur 只做 2px 且只在过渡带内生效，避免大面积 backdrop-filter 带来的滚动掉帧（对照 `docs/LOW_SPEC_OPTIMIZATION_DOCTRINE.md` 的低配策略）。

### 4.6 参数汇总表

| 名称 | 变量 | 桌面 | 小屏 ≤760 | 作用 |
| --- | --- | --- | --- | --- |
| 顶部安全区 | `--mlib-safe-top` | 126px | 104px | 停靠时内容起点低于搜索栏 |
| 底部安全区 | `--mlib-safe-bottom` | 150px / 96px（无播放器） | 132px | 停靠时内容终点高于播放器 |
| 渐变过渡带 | `--mlib-edge-feather` | 56px | 44px | 内容淡出所需距离 |
| 内容左右边距 | `--mlib-gutter` | clamp(24px, 3.2vw, 56px) | 20px | 与首页 72px 视口内缩量协调 |
| scroll-padding-top | — | safe-top + 8 | 同 | 锚点定位 |
| scroll-padding-bottom | — | safe-bottom + 8 | 同 | 触底定位 |

### 4.7 粘性分区导航的特殊处理

不是所有区块都做 sticky。**只有一条**横向分区导航（最近添加 / 专辑 / 歌曲 / 艺术家 / 歌单）在滚动时吸顶。

```css
.mlib-section-nav {
  position: sticky;
  top: 0;                        /* sticky 相对滚动容器的 padding box，天然落在安全区下沿 */
  z-index: 2;
  margin: 0 calc(var(--mlib-gutter) * -1);   /* 横向出血到 content box 边缘 */
  padding: 10px var(--mlib-gutter);
  background: linear-gradient(to bottom, rgba(3,6,8,.62), rgba(3,6,8,.30) 70%, transparent);
  backdrop-filter: blur(14px) saturate(1.2);
  transition: opacity .28s cubic-bezier(.16,1,.3,1), transform .28s cubic-bezier(.16,1,.3,1);
}
/* 不跟搜索栏抢位置：滚动到很浅的区域时自动淡出 */
body.mlib-scrolled .mlib-section-nav { opacity: .92; }
```

吸顶时导航条与搜索栏之间必须保持 ≥ 16px 视觉间隙，避免两层玻璃叠在一起显脏。

---

## 5. Search Bar / Content / Mini Player 三层关系

### 5.1 职责边界

| 层 | 角色 | 是否随滚动 | 是否被内容影响 |
| --- | --- | --- | --- |
| `#search-area`（L4, z=10） | 全局搜索入口，永远可用 | 否，固定 | 否。内容从它下面穿过，但不改变它的玻璃/边框/尺寸 |
| `#music-library-scroll`（L1, z=1） | 页面唯一滚动空间 | 自身滚动 | 被 mask 收边 |
| `#bottom-bar`（L3, z=6） | 播放控制，永远可用 | 否，固定 | 否。内容从它下面穿过 |

### 5.2 交互不冲突的保证

1. **指针事件**：`.mlib-edge-mask` 与 `.mlib-grain` 必须 `pointer-events: none`，否则会吃掉搜索栏/播放器的点击。
2. **滚动链**：滚动容器 `overscroll-behavior: contain`，滚到底不触发背景视觉的缩放/回弹；反过来也保证首页的页面级手势不会串进来。
3. **搜索框聚焦时**：搜索栏 `#search-area.peek` 的既有上浮行为不动；资料库内容不需要为它让位（因为内容本来就在它下面穿过，只是被 mask 淡出）。
4. **搜索结果展开时**（`#search-results`，`max-height: min(420px, calc(100vh - 210px))`）：结果面板会盖住资料库首屏。此时给滚动容器加 `body.mlib-search-open #music-library-scroll { filter: brightness(.72) saturate(.9); }`，用**压暗**而不是遮挡来保持层次。
5. **播放器展开**（`#bottom-handle` → 播放器控制台）：既有 `body.controls-visible` / `home-controls-locked` 状态逻辑不变；资料库只通过 `--mlib-safe-bottom` 感知，不自行切换。

### 5.3 三层视觉配重

```
搜索栏   ← 高对比玻璃 + 青色描边（既有 --glass-border）     视觉重量：高
─────────── 内容淡出带（56px）
内容     ← 最深、最不透明的一块（卡片 rgba(8,9,13,.76)）      视觉重量：中
─────────── 内容淡出带（56px）
播放器   ← 最通透的玻璃（既有 rgba(0,0,0,.10) + blur 12px）  视觉重量：高
```

> 上下两个浮层"重"、中间内容"实"，形成三明治式的层次感；内容的淡出带让两者之间的过渡不产生"切口"。

---

## 6. 推荐响应式布局

### 6.1 断点与网格

| 断点 | 场景 | 专辑列数 | 歌曲列表 | 艺术家列数 | 歌单列数 | 首屏最近添加 |
| --- | --- | --- | --- | --- | --- | --- |
| ≥ 1600 | 大屏 / 全屏 | 6 | 3 列 | 8 | 4 | 6 张 |
| 1440–1599 | 桌面默认 | 5 | 3 列 | 6 | 4 | 5 张 |
| 1200–1439 | 小桌面 | 5 | 2 列 | 5 | 3 | 5 张 |
| 1024–1199 | 紧凑桌面 | 4 | 2 列 | 4 | 3 | 4 张 |
| 761–1023 | 平板 / 窄窗 | 3 | 1 列 | 4 | 2 | 4 张 |
| ≤ 760 | 小窗 / 竖屏 | 2（≤560 时 1） | 1 列（紧凑行） | 3 | 1 | 3 张 |

用容器查询而不是纯视口查询更稳（窗口宽度经常在 1000–1300 之间抖动）：

```css
#music-library-scroll { container-type: inline-size; }

@container (min-width: 1180px) { .mlib-album-grid { --cols: 5; } }
@container (min-width: 960px) and (max-width: 1179px) { .mlib-album-grid { --cols: 4; } }
@container (max-width: 959px) { .mlib-album-grid { --cols: 3; } }
@container (max-width: 640px) { .mlib-album-grid { --cols: 2; } }

.mlib-album-grid {
  display: grid;
  grid-template-columns: repeat(var(--cols, 4), minmax(0, 1fr));
  gap: clamp(14px, 1.5vw, 24px);
}
```

### 6.2 窗口高度维度

除宽度外，**高度**同样重要（笔记本 768/800 高很常见）：

```css
@media (min-width: 761px) and (max-height: 760px) {
  :root {
    --mlib-safe-top: 112px;
    --mlib-safe-bottom: 132px;
  }
  .mlib-album-card--xl .mlib-art { aspect-ratio: 1 / 1; }   /* 封面缩小一档 */
  .mlib-section { margin-top: 34px; }                       /* 分区间距收紧 */
}
```

### 6.3 与桌面壁纸模式共存

既有桌面壁纸模式下有安全边距变量 `--desktop-safe-*`（见 `index.css:18119+`）。资料库必须同源，否则在壁纸模式下会被任务栏切到：

```css
body.desktop-wallpaper-mode #music-library-scroll {
  padding-top: calc(var(--mlib-safe-top) + var(--desktop-safe-top));
  padding-bottom: calc(var(--mlib-safe-bottom) + var(--desktop-safe-bottom));
  padding-left: calc(var(--mlib-gutter) + var(--desktop-safe-left));
  padding-right: calc(var(--mlib-gutter) + var(--desktop-safe-right));
}
```

---

## 7. 专辑墙 / 歌曲列表 / 艺术家 / 歌单视觉规范

### 7.0 通用卡片语言（与首页 `.home-card` 同源）

```css
.mlib-card {
  position: relative;
  border: 1px solid rgba(255, 255, 255, .085);           /* 同 .home-card */
  border-radius: 22px;                                    /* 同 .home-card */
  background: linear-gradient(142deg, rgba(18,21,26,.66), rgba(8,9,13,.76));
  box-shadow: 0 20px 64px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.060);
  backdrop-filter: blur(24px) saturate(1.12);
  -webkit-backdrop-filter: blur(24px) saturate(1.12);
  overflow: hidden;
  transition: transform .22s cubic-bezier(.16,1,.3,1),
              border-color .22s, background .22s, box-shadow .22s;
}
.mlib-card:hover {
  transform: translateY(-3px);
  border-color: rgba(0, 245, 212, .42);                   /* --home-accent 42% */
  background: linear-gradient(142deg, rgba(36,33,39,.72), rgba(10,10,14,.84));
  box-shadow: 0 28px 84px rgba(0,0,0,.36),
              0 0 34px rgba(0,245,212,.16),
              inset 0 1px 0 rgba(255,255,255,.085);
}
/* 只在有真实可播内容时出现的主色呼吸边 */
.mlib-card[data-playing="true"] { border-color: rgba(0,245,212,.62); }
```

**卡片右上角不使用 Apple Music 的 "+" / "⋯" 常驻按钮**。控制按钮只在 hover/focus 时淡入，保持首屏安静。

### 7.1 专辑墙（Recently Added · 大卡片）

```
┌───────────────────────┐
│                       │  ← 封面 1:1，圆角 18px
│       封面图           │     顶部有 1px 内高光
│                       │     悬停：scale(1.04) + 主色柔光
│                  ▶ ●  │  ← 右下角悬浮播放键（hover 淡入）
└───────────────────────┘
  专辑名称                  ← 13.5px / 600 / 单行省略
  周杰伦 · 2024             ← 11.5px / rgba(255,255,255,.55)
```

| 属性 | Recently Added（XL） | Albums 网格（M） |
| --- | --- | --- |
| 卡片宽度 | 236px（桌面）/ clamp(160px, 22vw, 236px) | 由网格决定 |
| 封面圆角 | 18px | 14px |
| 卡片内边距 | 0（封面出血到卡片边缘，仅底部文字区 12px 内边距） | 同 |
| 卡片圆角 | 26px | 22px |
| 标题字号 | 15px / 620 | 13.5px / 600 |
| 副标题 | 12px | 11.5px |
| 悬停位移 | `translateY(-4px)` | `translateY(-3px)` |
| 网格 gap | 横向滚动 gap 18px | `clamp(14px, 1.5vw, 24px)` |

「最近添加」用**横向滚动轨道**而不是网格：避免首屏出现两行密集封面导致的"数据倾倒"感。轨道两端加 48px 的 mask 淡出，滚动条隐藏，支持 `scroll-snap-type: x proximity`。

> **实现期修正（P1.0 实机反馈）**：专辑卡片**不再是玻璃框**。原规格给卡片套了 22px 玻璃底 + 描边 + 阴影，实机看起来每张封面都被装进一个盒子里，视觉噪声偏大。改为：
>
> | | 原规格（玻璃框） | 现规格（纯封面 + 透明文字） |
> | --- | --- | --- |
> | 卡片容器 | 22px 玻璃底 + 1px 描边 + 投影 | **无底色、无边框、无投影**（`background: none; border: 0`） |
> | 封面圆角 | `18px 18px 0 0`（只有上两角） | **`18px`（四角）** |
> | 封面阴影 | 卡片承担 | 移到封面上：`0 18px 48px rgba(0,0,0,.42)` + 内高光 |
> | 文字区 | 卡片内 `12px 14px 15px` 内边距 | `11px 6px 0`，**无底色** |
> | 文字对齐 | 左对齐 | **水平居中**（`text-align: center`） |
> | 文字可读性 | 靠卡片底色 | 靠 `text-shadow` 两级（标题 `.55` / 副标题 `.5`） |
> | 悬停 | 卡片上浮 + 描边变主色 + 主色辉光 | **封面**上浮 4px + 主色辉光；卡片本身只做位移 |
>
> 理由：这一区的视觉主体是**封面本身**，文字是附属信息。给每张封面加玻璃框会让 5 张卡变成 5 个"盒子"，与设计目标「克制、不堆砌」相反。文字直接落在背景上、居中，反而更像唱片墙。
>
> 运行时已断言：卡片透明（alpha=0）+ 边框 0 + 文字区透明 + 专辑名中线偏差 0px。

#### 4.4.1 ⚠️ 边缘淡出带的两条铁律（P1.0 实测踩出来的）

原设计把「安全区」和「淡出带」混成一个量（都用 `--mlib-safe-top`），结果**页头在静止状态下被 mask 裁掉**、**最后一行卡片标题被淡掉**。原因是几何上把三件事叠在了同一个坐标：

```
容器 padding-top = safe-top      →  内容第一像素在 y = safe-top
mask: transparent 0 → #000 safe-top →  内容起点正好在 mask 刚变不透明处
```

于是内容最顶部落在渐变带上，alpha < 1。修法是把「内容起点」从「安全区」里拆出来，并定下两条铁律：

**铁律 1（顶部）：淡出必须在内容起点之上完成。**

```css
:root { --mlib-content-top: var(--mlib-safe-top); }
/* 0 → content-top 完成淡出；content-top 以下一律 #000（完全不透明） */
mask-image: linear-gradient(to bottom,
  transparent 0,
  #000 var(--mlib-content-top),          /* 内容起点这里已经不透明 */
  ...);
```

**铁律 2（底部）：淡出必须在内容终点之下开始。**

```css
:root { --mlib-fade-bottom: 22px; }
/* 内容终点 = 100% - safe-bottom，必须落在不透明区内 */
mask-image: linear-gradient(to bottom,
  ...,
  #000 calc(100% - var(--mlib-fade-bottom)),                        /* 不透明到这儿 */
  transparent calc(100% - var(--mlib-fade-bottom) + var(--mlib-edge-feather)));
```

> **一句话**：mask 的淡出带只能覆盖「内容永远不该出现」的区域（搜索栏带 / 播放器带），**不能压在内容停靠位置上**。判断方法：静止时内容起点必须 ≥ mask 不透明起点，内容终点必须 ≤ mask 不透明终点。
>
> 实测数据（720px 高窗口）：`contentEnd=570` ≤ `opaqueEnd=698` 通过；修之前 `contentEnd` 与淡出带重叠。
>
> 另外 `--mlib-safe-bottom-idle` 也从 132 提到 **150px** —— 132 仍会让最后一行标题落进底部淡出带。

#### 7.1.1 排列参考 Apple Music：最近添加 + 专辑

Apple Music 的资料库是「**最近添加**（一屏网格）+ **专辑**（整个资料库网格）」。MineRadio 采用同样的排列：

| 区块 | API | 实测 |
| --- | --- | --- |
| 最近添加 | `/api/apple/library/albums?limit=40` | 40 张，`40 / 549` |
| 专辑 | `/api/apple/library/albums?limit=1000` | **549 张，`549 / 549`** |

- 两个区块共用同一套渲染/加载路径（模块里是 `createAlbumSection`），不重复实现；
- 列数用**容器查询**：默认 5 列，`≤1080px` 4 列，`≤860px` 3 列，`≤620px` 2 列，`≤380px` 1 列；
- 网格卡片宽度由列宽决定（不再是固定 236px），轨道才用固定宽度；
- 封面 `loading="lazy"`；`limit` 与实际返回数不一致时在网格下方给一行说明（如"已显示前 500 张，共 549 张"），而不是静默截断。

> **接口上限已提到 1000**（handler 与路由同步），让这一轴能一次铺满整个资料库。实测 549 张 = 6 次分页请求。

### 7.2 歌曲列表

```
── # ── ────── ──────────────────────────── ────────────── ────── ────
   01   ▢   晴天                          周杰伦           叶惠美   4:29   ♡ ⋯
   02   ▢   ⭐正在播放：稻香               周杰伦           魔杰座   3:43   ▮▮ ⋯
   ...
```

| 属性 | 值 |
| --- | --- |
| 行高 | 56px（紧凑模式 44px） |
| 行圆角 | 14px（hover 时出现底色） |
| hover 背景 | `rgba(255,255,255,.055)` + `inset 0 1px 0 rgba(255,255,255,.05)` |
| 序号列 | 固定 40px，`font-variant-numeric: tabular-nums`，色 `rgba(255,255,255,.4)`；hover 时序号变为 ▶ |
| 封面缩略图 | 40×40，圆角 10px |
| 分隔 | 不用边框线，用 4px 行距 + hover 底色区分（避免"表格感"） |
| 正在播放 | 左侧 2px 主色竖条 + 标题主色 + 序号位显示动态波形 3 条 |
| 时长 | 右对齐，12.5px，`tabular-nums` |
| 操作 | `♡` 与 `⋯` 默认 0 透明度，行 hover/focus-within 时淡入 |
| 多列 | ≥1200px 时按 `column-count` 分 2–3 列连续排布（阅读动线更接近"唱片墙"），列间 40px |

> 歌曲区**不做**每行常驻的下拉菜单和"更多"三连点，那是流媒体客户端列表的做法；MineRadio 保持克制的播放器气质。

### 7.3 艺术家卡片

```
     ╭───────╮
     │   ◯   │   ← 圆形头像 1:1，圆角 50%
     ╰───────╯      外圈 1px rgba(255,255,255,.12)
   周杰伦              + 内圈 1px rgba(var(--home-accent-rgb),.16)
   12 张专辑 · 186 首    + hover 时外圈扩散（scale 1.03）
```

| 属性 | 值 |
| --- | --- |
| 头像尺寸 | 88px（桌面）/ 72px（小屏） |
| 无头像兜底 | 径向渐变（取来源 accent）+ 名称首字，字号 32px / 700 |
| 名称 | 13.5px / 600，居中，单行省略 |
| 副信息 | 11.5px / `rgba(255,255,255,.5)`，居中 |
| 卡片容器 | 透明，不套玻璃框（避免首屏出现大量矩形） |
| hover | 头像 `scale(1.04)` + 外部 18px 主色柔光晕 |

### 7.4 歌单卡片

```
┌─────────────────────────┐
│ ▢▢▢  四宫格封面拼贴       │  ← 2×2 拼贴，圆角 16px
│ ▢▢▢                      │     缺图时用主色渐变 + 歌单首字
└─────────────────────────┘
  我喜欢的音乐               ← 14px / 620，两行省略
  128 首 · 更新于 3 天前      ← 11.5px / .55
```

| 属性 | 值 |
| --- | --- |
| 比例 | 16:9 封面 + 文案区，卡片整体 22px 圆角 |
| 拼贴 | 2×2，内部 gap 2px，整体圆角 16px |
| 卡片底色 | 比专辑卡更暗一档：`rgba(6,8,11,.72)`，让歌单区在视觉上"收尾" |
| hover | 拼贴 `scale(1.02)`，卡片上浮 3px |
| 角标 | 左上角小徽章区分来源（Apple Music / MineRadio），Phase 2 起出现 |

### 7.5 分区通用规范

```css
.mlib-section { margin-top: clamp(38px, 4.4vw, 64px); }
.mlib-section-head {
  display: flex; align-items: baseline; gap: 12px;
  margin-bottom: 18px;
}
.mlib-section-title { font-size: clamp(19px, 1.7vw, 24px); font-weight: 700; letter-spacing: .01em; }
.mlib-section-count { font-size: 12px; color: rgba(255,255,255,.42); font-variant-numeric: tabular-nums; }
.mlib-section-more  { margin-left: auto; font-size: 12.5px; color: rgba(255,255,255,.6); }
.mlib-section-more:hover { color: #fff; }
```

分区标题保持"中文主标题 + 小号英文 kicker"的双语结构（复用即可，不必新造），与首页 `.home-insight-kicker` 的排版习惯一致。

---

## 8. 动效建议

### 8.1 进入 / 退出

```css
#music-library-scroll {
  opacity: 0;
  transform: translateY(22px) scale(.994);
  filter: blur(10px);
  transition: opacity .46s cubic-bezier(.16,1,.3,1),
              transform .58s cubic-bezier(.16,1,.3,1),
              filter .46s cubic-bezier(.16,1,.3,1);
  pointer-events: none;
}
body.music-library-active #music-library-scroll {
  opacity: 1; transform: none; filter: blur(0); pointer-events: auto;
}
/* 退出：更快、更"退后" */
body.music-library-leaving #music-library-scroll {
  opacity: 0; transform: translateY(14px) scale(.99);
  filter: blur(8px);
  transition-duration: .26s;
  pointer-events: none;
}
```

搜索栏与播放器**不参与**这段动画（它们是全局常驻层），这样进入资料库时用户不会感觉"整个 App 换了个页面"，而是"资料库从下面升起来，浮层一直在"。

### 8.2 与首页的交叉过渡

```
body.music-library-active #empty-home { opacity: 0; pointer-events: none; }
/* 首页退场稍快于资料库进场，产生"交接"而不是"黑一下" */
```

### 8.3 卡片入场（滚动进入视口）

使用 `IntersectionObserver`，**只在首次进入时播放一次**，之后不再重播（避免来回滚动时的廉价感）：

```css
.mlib-reveal { opacity: 0; transform: translateY(16px); }
.mlib-reveal.is-in {
  opacity: 1; transform: none;
  transition: opacity .42s cubic-bezier(.16,1,.3,1),
              transform .52s cubic-bezier(.16,1,.3,1);
}
```

| 参数 | 值 |
| --- | --- |
| 触发阈值 | `rootMargin: '0px 0px -8% 0px'`（提前一点点） |
| 单批 stagger | 30ms，**最多 8 个**（第 9 个开始不延迟），避免长列表整体动画卡顿 |
| 位移 | 16px（专辑）/ 10px（歌曲行，更轻） |
| 总时长上限 | 单批 ≤ 240ms |

### 8.4 滚动相关

| 交互 | 动效 |
| --- | --- |
| 分区导航吸顶 | blur 背景 0 → 14px，200ms；同时淡出一条 1px 底部高光 |
| 粘性导航当前分区高亮 | 滑动指示器 220ms `cubic-bezier(.16,1,.3,1)`，不做弹簧 |
| 首屏标题 | 进入时逐行上浮（标题 40ms / kicker 80ms / chips 140ms），只播一次 |
| 滚动到顶 | 分区导航淡出（`body.mlib-scrolled` 移除），把首屏还给标题 |
| 内容穿过浮层 | **不做任何 JS 响应**——完全由 mask 承担。任何"根据滚动位置调透明度"的 JS 都会掉帧 |

### 8.5 播放态联动

| 场景 | 动效 |
| --- | --- |
| 点击专辑播放 | 封面 → 播放器左下角封面的共享元素过渡（FLIP 或 `clip-path` 路径），520ms |
| 当前播放行 | 左侧主色竖条从 0 → 2px 展开（180ms），波形 3 条交替起伏（1.2s/1.4s/1.0s） |
| 收藏 | ♡ 填充 + 一次性 1.06 回弹（不做无限 boun） |
| 加载更多 | 骨架屏微光横扫 1.6s infinite，`prefers-reduced-motion` 下改为静态 |

### 8.6 无障碍与降级

```css
@media (prefers-reduced-motion: reduce) {
  #music-library-scroll,
  .mlib-reveal,
  .mlib-card { transition-duration: .01ms !important; animation: none !important; }
}
```

---

## 9. 与当前 MineRadio 首页视觉语言的衔接

### 9.1 直接复用的既有 token（不新增同义变量）

| 用途 | 复用 |
| --- | --- |
| 玻璃背景 | `--glass-bg` / `--glass-bg-focus`（`index.css:322`） |
| 玻璃描边 | `--glass-border`（`rgba(0,245,212,.30)`）、`--glass-border-soft` |
| 玻璃阴影 | `--glass-shadow` / `--glass-shadow-focus` |
| 主色 | `--home-accent` / `--home-accent-rgb`（`#00f5d4`） |
| 来源色 | `--source-qq` `#00F5D4`、`--source-netease` `#d95b67`、`--source-local` `#9db8cf` |
| 深色底 | `--chill-ink` `#030608`、`--chill-deep` `#061116` |
| 强调暖色 | `--champagne` `#f4d28a`（用于"未登录/需要授权"这类提醒，与既有登录引导一致） |
| 状态类 | `.controls-visible` / `.soft-hidden` / `.empty-home-active` / `.desktop-wallpaper-mode` 等既有 body class，只读不新增逻辑 |

### 9.2 语气与手法的延续

| 首页的手法 | 资料库的延续 |
| --- | --- |
| 卡片圆角 22px、1px 微描边、内高光 `inset 0 1px 0 rgba(255,255,255,.06)` | 完全一致 |
| hover 上浮 3px + 主色柔光 | 完全一致（专辑/歌单卡片） |
| `home-card-float` 7.4s 缓慢浮动 | **不复制**。首页是少量卡片，可以浮；资料库是长列表，浮动会变成噪声。资料库只保留 hover 反馈 |
| 背景透出 + 颗粒 | 保留，资料库额外加一层跟随封面的氛围光晕 |
| 文案用「中文主 + 英文 kicker」 | 保留（`MUSIC LIBRARY` / `RECENTLY ADDED` / `ALBUMS`…） |
| 状态文案诚实（"没有可信推荐接口时会明确留空"） | 保留：未授权时显示明确的 Apple Music 授权引导，而不是空网格 |
| 字体栈 Inter + Noto Sans SC | 保留。**仅**页面大标题可选择性使用 `Cinzel Decorative`（与 splash wordmark 同源），其他一律不用衬线，避免"Apple Music 味" |

### 9.3 明确**不**做的事（避免变成 Apple Music 副本）

- ❌ 不做 Apple Music 的红色/粉紫双色大渐变背景
- ❌ 不使用 Apple Music 的左侧常驻侧边栏 + 顶部大标题滚动收缩模式
- ❌ 不做"标题随滚动缩成导航条"的 iOS 大标题行为
- ❌ 不在卡片上常驻「+」「⋯」「⤓」按钮
- ❌ 不使用系统 UI 字体件（SF Pro）语义；坚持 Inter + Noto Sans SC
- ❌ 不把「音乐库」旧入口改名或改指向

### 9.4 应该一眼看出的 MineRadio 特征

1. 青色（`#00f5d4`）玻璃描边在暗底上的微弱辉光；
2. 内容**穿过**搜索栏与播放器、被渐变柔和吃掉——这是这个页面最独特的手感；
3. 卡片是"暗玻璃"而不是"白底列表"，即使全是封面也不会显得吵；
4. 分区标题的双语 kicker 排版节奏；
5. 播放器始终在场，资料库只是它上面的一层可滚动的"唱片墙"。

---

## 附：实现阶段排期与落点清单（本阶段不实施）

### 分阶段推进（严格顺序，不跳步）

| 阶段 | 内容 | 完成判据（Gate） |
| --- | --- | --- |
| **P1-Nav 导航** | `#mlib-nav` 独立锚点 + 纯图标 `#music-library-btn` + `openMusicLibrary()` / `closeMusicLibrary()` + Library **空壳页面**（仅页头占位） | 0.2 节验收口径全过：入口稳定存在、Home↔Library 往返正常、账号胶囊自动隐藏时仍可达 |
| **P1.0 骨架 + 最近添加** ✅ | `#music-library-scroll` + 安全区 + mask；接 `GET /api/apple/library/albums`，横向专辑轨道渲染真实资料库 | 真实 549 张专辑按 dateAdded 新→旧画出封面墙，内容不被上下浮层吃掉 |
| **P1.1 接真数据** | 直连现有 Apple Music Library 能力，替换假数据；五个分区按真实数据有无条件渲染 | 真实数据下首屏密度、长列表滚动、图片加载都不崩 |
| **P1.2 手感验证** | 1440×760 / 1024×900 / 小窗 / 桌面壁纸模式逐项过验收口径 | 6 条验收口径全过 |
| **P2 抽多来源** | 此时才引入 Provider 抽象（第 2 节存档接口） | 第二个真实来源落地，且 P1 的页面结构零改动 |

> ⚠️ **P1-Nav 到 P1.2 全程禁止触碰 Provider / registry / capability 抽象**（见 0.3 护栏）。P2 的启动条件是"第二个来源已经确定要接"，不是"架构看起来该重构了"。

### 落点清单

| 文件 | 预期改动 |
| --- | --- |
| `public/index.html` | **P1-Nav**：新增 `#mlib-nav` 导航锚点（`#top-right` 的**兄弟节点**，不是子元素）；`#home-btn` 原地保留、仅补 `aria-current`；**P1.0**：新增 `#music-library-scroll` 空壳结构。全程不动原有卡片节点 |
| `public/css/index.css` | 新增 `/* ---------- 音乐资料库 ---------- */` 段落与 `.mlib-*` 命名空间；或在 `public/css/` 下新增独立分片 |
| `public/js/modules/…` | 新增**一个扁平**的 `mlib-*` 模块：状态、渲染、IntersectionObserver、滚动定位。**不含 Provider / registry / capability 层**，仅保留一个标注好的 seam 函数（见 0.3 护栏） |
| 测试 | **P1-Nav 已落地**：`tests/music-library-shell.test.js`（结构契约）+ `scripts/check-music-library-shell-live.js`（CDP 运行时，47 项断言，`--shot` 可截图）。P1.0 起再补「安全区参数」「scroll-margin」「分区按数据有无条件渲染」 |

**验收口径（设计层）**

1. 打开资料库首屏只出现页头 + 最近添加一行；
2. 滚动中内容确实从搜索栏、播放器下面穿过，且看不到任何矩形裁切边；
3. 把窗口拉到 1440×760 与 1024×900，内容都不被浮层压住；
4. 键盘 Tab 定位到任意歌曲行时，该行完整可见（不被底部播放器遮挡）；
5. 隐藏播放器后，底部留白收紧且不出现悬空的大空白；
6. 未登录 Apple Music 时，页面给出明确的授权引导而非空白网格；
7. **导航往返**：Home 与 音乐资料库 之间可互相到达，纯图标入口的激活态互斥，账号胶囊自动隐藏模式下导航仍可见可点（见 0.2 验收口径）；
8. **护栏自检**：全仓库搜索 `LibraryProvider` / `registerProvider` / `capabilities` 等抽象符号，在 P1 系列提交中**命中数为 0**；只有 0.3 节标注的那个 seam 函数存在。

---

*本文档为 Phase 0 设计定稿提案，不含任何代码改动。*
*文档状态：定稿。下一刀 = **P1-Nav**（只做 0.2 节的导航关系 + Library 空壳：独立锚点 `#mlib-nav` + 与 `#home-btn` 同款的纯图标入口，验证三件事 —— 入口稳定存在 / Home↔Library 往返正常 / `user-capsule-auto-hide` 下仍可用）。P1.0 视觉实现待 P1-Nav 验收通过后开始。*


