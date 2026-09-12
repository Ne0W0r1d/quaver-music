<p align="center">
  <img src="img/quaver-icon-dark.svg" width="96">
</p>
# Quaver Music- 又一个第三方 QQ 音乐客户端

Quaver Music，是一款 QQ 音乐的第三方客户端，其目的是为了让 Linux DE / Wayland WM 用户能够爽用，基于 Electron + Astro 实现

名字取自于八分音符，对应了音乐，“QQ” 的 Q 字母。

> [!CAUTION]
> 真爱音乐，尊重正版，音乐平台不易，该应用**不提供盗版 QQ 音乐服务！**

# 契机

我一直是 QQ 音乐的用户，也用过 NCM 的第三方客户端，Spotify，Apple Music。

然而 QQ 音乐一直没有什么好用的第三方客户端，而同 TME 系的有 [MoeKoe](https://music.moekoe.cn/) ，而转机是在 Lyrune。

我贡献了个 Vibe Coding 的 Inhibit 和 CI AppImage 构建的 PR，但一直觉得没有 CSD，上游作者也认为 CSD 对 WM 不重要，隔壁群有认为，这样在 DE 还是难受，故我觉得有必要考虑重新实现一个第三方的 QQ 音乐客户端，使用 Electron，对接入 NodeJS 的 API 而言也很方便，开发也很快，也可以避免我孱弱的 Rust 开发，与此同时，后端我也能玩 C++ 等。故此项目诞生，现正在 Prototype 阶段，逐步新增功能。

# 协议

该项目使用 AGPLv3 及其未来版本协议协议，其使用的 API 使用 GPLv3 及其未来版本协议和 MIT 协议

[NodeJS - MIT - yakult-green-tea](https://github.com/yakult-green-tea/qq-music-api)
[Python - GPLv3-or-later - l-1124](https://github.com/l-1124/QQMusicApi)
