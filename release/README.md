# Gitee 更新源发布说明

当前客户端使用 Tauri v2 官方 updater，更新清单地址配置在
`src-tauri/tauri.conf.json`：

```text
https://gitee.com/masongzhi1/raw-jpeg-matcher-mac-client/raw/main/release/latest.json
```

如果实际 Gitee 仓库不是 `masongzhi1/raw-jpeg-matcher-mac-client`，发布前请同步修改
`tauri.conf.json` 中的 updater endpoint。

## 1. 签名 key

本机已生成 updater key：

```bash
~/.tauri/raw-jpeg-matcher.key
~/.tauri/raw-jpeg-matcher.key.pub
```

私钥只用于构建签名更新包，不能提交到仓库。`tauri.conf.json` 中只保存公钥内容。

## 2. 构建更新包

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.tauri/raw-jpeg-matcher.key")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri -- build
```

Tauri 会生成普通安装包和 updater artifacts。常见路径：

```text
src-tauri/target/release/bundle/macos/照片配对助手.app.tar.gz
src-tauri/target/release/bundle/macos/照片配对助手.app.tar.gz.sig
src-tauri/target/release/bundle/nsis/*.exe
src-tauri/target/release/bundle/nsis/*.exe.sig
src-tauri/target/release/bundle/msi/*.msi
src-tauri/target/release/bundle/msi/*.msi.sig
```

Windows 如果改为 v1Compatible artifacts，会出现 `.zip` 更新包，以实际构建产物为准。

## 3. GitHub Actions 自动发布

`main` 分支收到提交后，`.github/workflows/build-installers.yml` 会自动：

1. 在 macOS 构建 `.dmg`、`.app.tar.gz` 和 `.app.tar.gz.sig`。
2. 在 Windows 构建 NSIS `.exe` 和 `.exe.sig`。
3. 生成 `latest.json`，其中 `signature` 来自本次构建生成的 `.sig` 文件内容。
4. 上传安装包、updater 包、签名文件和 `latest.json` 到 GitHub Release。
5. 同步同一批文件到 Gitee Release。
6. 写入 Gitee 仓库 main 分支的 `release/latest.json`。

GitHub 仓库需要配置这些 Actions Secrets：

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
GITEE_ACCESS_TOKEN
```

`TAURI_SIGNING_PRIVATE_KEY` 使用 `~/.tauri/raw-jpeg-matcher.key` 文件内容。
当前本机生成的 key 没有密码，因此 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 可以留空或配置为空字符串。

## 4. 手动发布到 Gitee

1. 在 Gitee 创建 release，例如 `v0.1.17`。
2. 上传对应平台的 updater artifact 和 `.sig` 文件。
3. 复制 `release/latest.example.json` 为 `release/latest.json`。
4. 把 `version`、`pub_date`、`notes`、各平台 `url` 和 `signature` 替换为真实值。
5. 将 `release/latest.json` 推送到 Gitee 仓库 main 分支。

`signature` 必须粘贴 `.sig` 文件内容本身，不是 `.sig` 文件 URL。

## 5. 验证

```bash
curl -I "https://gitee.com/masongzhi1/raw-jpeg-matcher-mac-client/raw/main/release/latest.json"
```

安装旧版本客户端后点击顶部“检查更新”，确认能检测、下载、安装并重启到新版本。
