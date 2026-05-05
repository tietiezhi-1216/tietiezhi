package webui

import "embed"

// Dist 是打包进二进制的 WebUI 静态文件。
//
// `task web:build` 会把 web/build 同步到 dist 目录，然后 Go 编译时
// 将这些文件嵌入最终二进制。
//
//go:embed all:dist
var Dist embed.FS
