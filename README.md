# Taobao Image Search Runner

这是一个可转发给同事的本地运行包。它不依赖原作者机器上的绝对路径，也不包含原机器上的淘宝登录态、浏览器 profile 或 cookie。

## 第一次安装

需要先安装 Node.js 20 或更新版本。

macOS / Linux:

```bash
./setup.sh
```

Windows:

```cmd
setup.cmd
```

安装脚本会执行 `npm install`。如果机器上已经安装 Google Chrome，它会直接复用系统 Chrome，不再强制下载 Playwright Chromium。

## 使用方式

单张图片：

```bash
./taobao-image-search --image /path/to/image.png
```

批量图片目录：

```bash
./taobao-image-search --image-dir /path/to/folder
```

Windows 用：

```cmd
taobao-image-search.cmd --image C:\path\to\image.png
```

结果默认写入当前目录下的 `outputs/`：

- `taobao-image-search-latest-report.md`
- `taobao-image-search-latest-items.csv`
- `taobao-image-search-latest-response.json`
- `taobao-image-search-latest.curl.sh`

批量模式还会生成 `outputs/taobao-image-search-batch-items.csv`。

## 首次登录和风控

第一次运行会打开浏览器。若淘宝要求登录、扫码或验证，请在打开的浏览器里完成操作。工具会把当前机器自己的 session 保存到本目录的 `session-cookies.json` 和 `profile/`，只在本地使用。

如果登录态异常，可以删除：

```bash
rm -rf profile session-cookies.json
```

然后重新运行。

## 常用参数

```bash
./taobao-image-search --help
```

常用选项：

- `--out /path/to/outputs` 指定输出目录
- `--profile /path/to/profile` 指定浏览器 profile
- `--image-dir /path/to/folder --recursive` 递归处理目录图片
- `--batch-delay-ms 20000 --batch-jitter-ms 10000` 批量模式降低触发风控概率
- `--verbose` 输出更详细日志

不建议第一次运行就加 `--headless`，因为淘宝通常需要人工登录或验证。

## Playwright Chromium 下载超时

如果看到 `chrome-for-testing-public ... timed out`，优先安装 Google Chrome，然后重新运行：

```bash
./setup.sh
./taobao-image-search --image /path/to/image.png
```

如果不能安装 Google Chrome，可以延长超时时间后重试下载：

```bash
PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=120000 npm run install-browser
```

如果 Chrome/Chromium 安装在非标准位置：

```bash
TAOBAO_CHROME_EXECUTABLE=/path/to/chrome ./taobao-image-search --image /path/to/image.png
```
