# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- PhoenixField 本体を実装。テキスト系フォームへの入力をページ（URL）ごとに `chrome.storage.local` へ自動保存する機能
- ページ内ツールバー（details 式に開閉）。保存データとフォームコントロールを手動で対応付け、「自動入力を実行」で一括復元する機能
- 世代管理。一定間隔＋変化量でのスナップショット、内容急減時の緊急スナップショット、保持日数と容量に応じた自動ローテート
- 設定画面（自動保存 ON/OFF、対象範囲、世代設定、データ管理、エクスポート、ストレージ使用量表示）
- 仕様書 `docs/spec.md`、アイコン、Chrome ウェブストア向け紹介文（`promotion/`）

### Changed

- 拡張機能名を「PhoenixField」に決定し、`_locales` の名称・説明文を正式なものに更新
- ポップアップ UI は使わない設計としたため、`manifest.json` の `action.default_popup` を廃止（操作はページ内ツールバーで行う）
