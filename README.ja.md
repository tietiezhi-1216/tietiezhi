<div align="center">

<img src="./assets/brand/tietiezhi-mark-transparent.png" alt="Tietiezhi のタコロゴ" width="120">

# Tietiezhi · 鉄鉄汁

**あらゆるデバイスを、あらゆる AI モデルへ。**

macOS、Windows、Linux、iOS、Android、サーバー、エッジノードをつなぐオープンなエージェントネットワーク。

[简体中文](./README.md) · [English](./README.en.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md)

[⬇️ macOS / Windows 版をダウンロード](https://tietiezhi-1216.github.io/tietiezhi/) · [📦 リリース](https://github.com/tietiezhi-1216/tietiezhi/releases/latest) · [🗺️ ロードマップ](./docs/ROADMAP.en.md) · [🔒 プライバシー](./docs/PRIVACY.md) · [💬 Issues](https://github.com/tietiezhi-1216/tietiezhi/issues) · [⚖️ Apache-2.0](./LICENSE)

</div>

<div align="center">

<img src="./docs/images/tietiezhi-choose-model.jpg" alt="モデルを選択する前の Tietiezhi デスクトップ" width="860">

<sub>プロバイダー接続後、新しいタスクに適したモデルをユーザーが選択</sub>

</div>

## Tietiezhi とは

Tietiezhi は、**デバイス × モデルの相互接続**を中心に据えたオープンソース AI プロジェクトです。一台のコンピューター、一つのチャット画面、一つのモデルにすべてを集めるのではなく、デスクトップ、モバイル、独立したサーバーバイナリ、エッジデバイスを一つのエージェントネットワークとして接続することを目指します。

推論、コード、音声、画像、動画、低遅延処理など、モデルごとに得意分野は異なります。Tietiezhi は、デバイスとタスクに応じて適切なモデル、ツール、コンテキストを結び付け、それぞれのモデルが最も得意な仕事を担当できるようにします。

現在提供している製品は **macOS 13.3 以降**と **Windows 10/11（x64）**向けのデスクトップエージェントです。Go Server には Hub とデバイス接続の基盤があります。Linux、iOS、Android クライアントと完全なデバイス間連携はロードマップ上の計画であり、まだ完成品として公開されていません。

## 一つのネットワークで、モデルの長所を生かす

| レイヤー | 現在の基盤 | 目指す方向 |
| --- | --- | --- |
| デバイス | macOS / Windows デスクトップ | Linux、iOS、Android、独立バイナリ、エッジノード |
| Hub | Go 単一バイナリとデバイス登録・メッセージルーティング基盤 | ローカル sidecar / リモート Hub による検出、同期、タスク移動 |
| モデル | 複数の OpenAI 互換サービス、テキスト、音声認識 | 推論、コード、音声、画像、動画、音楽、ベクトルモデルの能力ルーティング |
| Agent | ローカルツール、権限、Skills、MCP、分離ワークスペース | デバイス間協調、委任、自動化、統一実行履歴 |

## 現在利用できるデスクトップ機能

| 機能 | 現在の実装 |
| --- | --- |
| 複数のモデルサービス | Tietiezhi Gateway、または複数の OpenAI 互換サービスを追加し、モデルを同期・切り替え可能 |
| ローカルエージェント | ストリーミング会話、複数段階のツール実行、システムプロンプト、再利用可能なエージェント設定 |
| ツールと権限 | ファイル、編集、検索、シェル、ネットワーク取得ツールと、3 段階の権限モード |
| Skills と MCP | Markdown ベースの Skills、stdio / Streamable HTTP MCP サーバーに対応 |
| プロジェクトとタスク | ローカル履歴、ワークスペース、ピン留め、アーカイブ、Git リポジトリ用の分離 worktree |
| 音声入力 | グローバルショートカット、音声認識、モデルによる文章整形、使用中アプリへのテキスト挿入 |
| ローカルファースト | API Key は macOS Keychain / Windows Credential Manager に保存。広告、追跡、テレメトリなし |

## クイックスタート

1. [公式サイト](https://tietiezhi-1216.github.io/tietiezhi/)または [GitHub Releases](https://github.com/tietiezhi-1216/tietiezhi/releases/latest) からインストーラーをダウンロードします。
2. 「設定 → プロバイダー」で Tietiezhi Gateway を使うか、OpenAI 互換の `baseURL` と API Key を追加します。
3. モデルを同期・選択し、新しいタスクを作成します。ローカルリポジトリを扱う場合はプロジェクトフォルダーを選択します。
4. 必要に応じてエージェント、Skills、MCP、ツール権限を設定します。

> Tietiezhi に個人用 API Key は同梱されていません。外部モデルの料金とデータ処理規約は各サービス提供者が定めます。

## 言語対応

README と公式サイトは、簡体字中国語・英語・日本語・韓国語に対応しています。デスクトップアプリの UI は現在、主に簡体字中国語です。アプリ全体の国際化は短期ロードマップに含まれています。翻訳の改善 Pull Request も歓迎します。

## ロードマップ

現在のデスクトップエージェントを起点に、デバイスが状況と実行環境を提供し、モデルが専門能力を提供し、Agent が明確な権限の下で両者を接続する**ユーザー主導のデバイス・モデルネットワーク**へ発展することが目標です。

短期的には、アプリの国際化、macOS / Windows の安定性と署名・更新、多サービス接続、ツール承認、Skills / MCP、タスクとワークスペース体験を改善します。その後、`server/` との統合方式、デバイス連携、利用量・コスト表示を進めます。長期的にはマルチエージェント、Codex / Claude Code / opencode 連携、マルチモーダル、ビジュアルワークフローと自動化を検討します。

詳細は[英語版ロードマップ](./docs/ROADMAP.en.md)をご覧ください。

## リポジトリ構成

| パス | 内容 |
| --- | --- |
| [`desktop/`](./desktop) | Tauri 2 + Rust + React 19 + TypeScript 製のデスクトップアプリ |
| [`server/`](./server) | OpenAI 互換 API、チャンネル、メモリ、スケジューラー、デバイス連携基盤を持つ Go Agent Hub |
| [`website/`](./website) | 多言語の公式サイトとダウンロードページ |
| [`assets/brand/`](./assets/brand) | ロゴ、マスコット、アプリアイコンの素材 |
| [`docs/`](./docs) | ロードマップ、プライバシー、コード署名に関する文書 |

## 開発

デスクトップ版には Node.js 22+、pnpm 9+、Rust stable、および各 OS の Tauri 依存環境が必要です。

```bash
cd desktop
pnpm install
pnpm tauri dev
```

開発に参加する前に、リポジトリの開発規約 [`CLAUDE.md`](./CLAUDE.md) をお読みください。バグ報告や提案は [Issues](https://github.com/tietiezhi-1216/tietiezhi/issues) で受け付けています。公開 Issue に API Key や機密情報を投稿しないでください。

## ライセンス

Copyright © 2026 Tietiezhi. [Apache License 2.0](./LICENSE) で公開されています。データの取り扱いについては[プライバシーポリシー](./docs/PRIVACY.md)をご覧ください。
