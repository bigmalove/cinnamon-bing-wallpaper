# Bing Wallpaper — Linux Mint (Cinnamon) 扩展

[English README](README.md)

自动获取 Bing 每日一图并设置为桌面壁纸的 Cinnamon 扩展（Extension）。

- 每天自动下载 Bing 首页图片（默认 4K UHD），并设为系统壁纸
- 可选地区（中国 / 美国 / 日本 … 或跟随系统语言）、分辨率、图片显示方式
- 断网、代理、登录时网络未就绪等情况自动重试；联网恢复后立即补拉
- 图片保存到「图片/BingWallpapers」目录（可改），自动清理旧图（只删除本扩展下载的文件）
- 可选在桌面右上角以纯文字常驻显示当前图片的标题、版权和日期（文字颜色、文字特效、每行字数、字号可调）
- 壁纸更换时弹出通知，显示图片标题与版权说明
- 设置面板提供「立即刷新 / 在 Bing 上查看介绍 / 打开壁纸目录」按钮
- 界面支持中文（gettext 翻译），已在 Linux Mint 22.3 / Cinnamon 6.6 上测试；兼容 Cinnamon 5.0–7.0（libsoup 2 与 3 均支持）

## 目录结构

```
cinnamon-bing-wallpaper/
├── install.sh                          # 安装 / 更新 / 卸载脚本
├── README.md                           # 英文说明
├── README.zh-CN.md                     # 本文件
├── LICENSE                             # GPL-2.0-or-later
├── spice/                              # 提交到 Cinnamon Spices 用的 info.json、README、截图
├── tools/export-spice.sh               # 把扩展复制进 cinnamon-spices-extensions 仓库的脚本
└── bing-wallpaper@bigmalove/           # 扩展本体（UUID = 目录名）
    ├── metadata.json                   # 名称、作者、兼容的 Cinnamon 版本
    ├── extension.js                    # 主逻辑
    ├── settings-schema.json            # 设置面板定义
    ├── stylesheet.css                  # 桌面图片信息文字样式
    ├── icon.png / icon.svg             # 图标
    └── po/                             # 翻译（zh_CN.po 及 .pot 模板）
```

## 安装

```bash
bash install.sh            # 复制到 ~/.local/share/cinnamon/extensions/ 并启用
bash install.sh status     # 查看是否已安装/启用、当前壁纸、最近日志
```

启用后几秒钟内会拉取第一张图片。若不想立刻启用，使用 `bash install.sh --no-enable`，之后在
「系统设置 → 扩展」中手动启用。

手动安装（不使用脚本）：把 `bing-wallpaper@bigmalove` 目录复制到
`~/.local/share/cinnamon/extensions/`，然后在「系统设置 → 扩展」里启用；中文界面需要另外执行
`msgfmt -o ~/.local/share/locale/zh_CN/LC_MESSAGES/bing-wallpaper@bigmalove.mo bing-wallpaper@bigmalove/po/zh_CN.po`。

## 设置

「系统设置 → 扩展 → Bing 壁纸 → 齿轮图标」打开设置面板：

| 页面 | 选项 | 说明 |
| --- | --- | --- |
| 常规 | Bing 地区 | 默认「自动」，根据系统语言选择市场（中文系统即 zh-CN）。部分地区每日图片不同 |
| 常规 | 图片分辨率 | 默认 4K UHD；若某张图没有该分辨率，自动退回 1920x1200 / 1920x1080 |
| 常规 | 图片显示方式 | 对应系统的 picture-options（放大、缩放、拉伸、居中、跨屏、马赛克），也可选择「保持系统当前设置」 |
| 常规 | 壁纸更换时显示通知 | 通知中显示图片标题、版权信息和缩略图 |
| 常规 | 在桌面上显示图片信息 | 在桌面右上角（面板下方）以纯文字显示标题、版权和日期，位于桌面层、不遮挡窗口。可调：文字颜色、文字特效（无 / 阴影 / 阴影增强 / 发光 / 描边 / 独立文字背景）、每行字数、字号 |
| 常规 | 操作按钮 | 立即刷新 / 在 Bing 上查看图片介绍 / 打开壁纸目录 |
| 存储与更新 | 壁纸保存位置 | 留空为 `~/图片/BingWallpapers`（跟随 XDG 图片目录） |
| 存储与更新 | 保留的图片数量 | 默认 30 张，超出的旧图自动删除；只删除文件名形如 `20260903_xxx.jpg` 的本扩展文件 |
| 存储与更新 | 检查新图片的间隔 | 默认 60 分钟。Bing 每天一图，检查请求非常小 |
| 存储与更新 | 按流量计费的网络下不下载 | 默认关闭 |

## 工作方式

1. 请求 `https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=<地区>` 获取当天图片信息。
2. 按 `日期_图片ID_分辨率.jpg` 命名（例如 `20260903_Westerheversand_ZH-CN0517707643_UHD.jpg`），若文件已存在则不重复下载。
3. 下载完成后写入 `org.cinnamon.desktop.background picture-uri`（以及 picture-options），并清理旧图。
   如果 Cinnamon 自带的「背景幻灯片」处于开启状态，会被关闭，否则它会立刻覆盖壁纸。
4. 每隔设定的间隔重新检查；失败时按 30s → 60s → 2min → 5min → 10min → 30min 退避重试，连续失败 3 次会弹出一次通知。
   网络恢复（NetworkMonitor 信号）时也会触发检查。
5. 当天图片已经设置过之后，如果你手动换了别的壁纸，扩展不会在当天再把它改回来；第二天有新图时才会更新。
   点击「立即刷新」则总是重新应用当天的图片。

网络请求使用 GLib/libsoup，自动遵循系统代理设置（环境变量或「网络 → 代理」）。

## 常见问题

- **壁纸没有变化**：运行 `bash install.sh status` 查看最近日志；或查看 `~/.xsession-errors` 中带
  `[bing-wallpaper@bigmalove]` 前缀的行。也可以按 Alt+F2 输入 `lg` 打开 Melange 查看日志。
- **只想用某个地区的图**：在设置里把「Bing 地区」从「自动」改为具体地区，会立刻重新获取。
- **想换回原来的壁纸**：在「系统设置 → 扩展」中禁用本扩展，然后在「系统设置 → 背景」里选择壁纸即可；
  下载过的图片仍保留在壁纸目录中。

## 卸载

```bash
bash install.sh uninstall           # 禁用并删除扩展，保留已下载图片和设置
bash install.sh uninstall --purge   # 同时删除设置
```

## 开发

```bash
bash install.sh --link     # 以符号链接方式安装，改代码后无需重新复制
bash install.sh reload     # 通过 DBus 让 Cinnamon 重新加载扩展
```

更新翻译：修改 `po/zh_CN.po` 后重新执行 `bash install.sh`（会用 msgfmt 编译到
`~/.local/share/locale/`）。新增字符串可用 `cinnamon-xlet-makepot` 提取（需要安装 `python3-polib`）。

设置面板中的按钮通过 `settings-schema.json` 里的 `callback` 字段调用 `enable()` 返回对象上的同名方法
（`onRefreshNow`、`onOpenBingPage`、`onOpenFolder`）。

### 发布到 Cinnamon Spices

```bash
tools/export-spice.sh /path/to/cinnamon-spices-extensions   # 按 Spices 目录结构复制并运行 validate-spice
```

扩展以 `bing-wallpaper@bigmalove` 提交到 <https://github.com/linuxmint/cinnamon-spices-extensions>；
`spice/` 目录下是 Spices 层面的 `info.json`、`README.md` 和 `screenshot.png`。

## 许可证

GPL-2.0-or-later，见 `LICENSE`。
