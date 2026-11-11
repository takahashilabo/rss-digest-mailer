# rss-digest-mailer

[github-rss-reader](https://github.com/takahashilabo/github-rss-reader) の記事データをもとに、
毎日1回、興味に合いそうな記事だけを選んでメールで届けるダイジェスト生成ツール。

Inoreaderなどの有料APIは使わない。興味の基準は `interests.md`（このリポジトリにある静的ファイル）で、
毎日のジョブはこれを読むだけ。はてなブックマークへのアクセスは毎日の自動ジョブには一切含まれない。

- github-rss-readerの `docs/data/articles.json`（新着記事）
- `interests.md`（興味関心プロファイル。[MONTHLY_REFRESH.md](./MONTHLY_REFRESH.md) の手順でおおよそ月1回、
  Claude Pro/Code との対話で手動更新・蓄積する。自動では更新されない）

## 仕組み

1. `articles.json` から直近26時間以内に公開された記事を候補として抽出
2. `interests.md` を読み込む
3. Gemini API に「興味関心プロファイル」と「候補記事」を渡し、5〜15件を選んで要約・理由付けさせる
4. HTML/テキストメールを組み立てて、Gmail経由で送信
5. メールには記事ごとの直リンクに加えて、**その日の候補記事全件**を一括で既読にする「このダイジェストを全て既読にする」リンクを入れる
   - リンク先は github-rss-reader の `docs/mark-all.html?from=...&to=...`（候補記事の日時範囲を渡すだけで、id一覧はURLに含めない）
   - 開くと、github-rss-readerが使っているのと同じ localStorage (`ghRssReader.readIds`) にその範囲の記事idをまとめて書き込むだけの軽量ページが表示される
   - そのため、既読にするブラウザ/端末は普段 github-rss-reader を見ているものと同じである必要がある（localStorageなのでサーバー同期はされない）

Gemini APIの呼び出しに失敗した場合は、新しい順に最大15件を機械的に選ぶフォールバックで動く（要約・理由は空になる）。

## セットアップ

1. このリポジトリをGitHubにpush
2. **Settings → Secrets and variables → Actions** で以下を設定
   - `GEMINI_API_KEY`: https://aistudio.google.com/apikey で発行（クレジットカード登録不要の無料枠あり）
   - `GMAIL_USER`: 送信元/送信先に使うGmailアドレス
   - `GMAIL_APP_PASSWORD`: Googleアカウントで2段階認証を有効にした上で発行する[アプリパスワード](https://myaccount.google.com/apppasswords)
   - `RECIPIENT_EMAIL`（任意）: 送り先を`GMAIL_USER`と変えたい場合のみ設定
3. Actionsタブから `Send daily digest` を手動実行（`workflow_dispatch`、`dry_run: true`にすればメール送信せず内容をログに出すだけにできる）して動作確認
4. 問題なければ毎日08:30 JSTに自動実行される（github-rss-reader側の08:00 JST fetchの30分後）
5. おおよそ月1回、[MONTHLY_REFRESH.md](./MONTHLY_REFRESH.md) の手順で `interests.md` を更新する

## 調整できるパラメータ（環境変数、`.github/workflows/digest.yml`で設定）

| 変数 | デフォルト | 内容 |
|---|---|---|
| `ARTICLES_URL` | github-rss-readerの`articles.json` | 候補記事の取得元 |
| `READER_BASE_URL` | github-rss-readerのPages URL | `mark-all.html`の起点 |
| `INTERESTS_PATH` | リポジトリ直下の`interests.md` | 興味関心プロファイルのファイルパス |
| `CANDIDATE_WINDOW_HOURS` | `26` | 候補記事とみなす公開からの経過時間 |
| `GEMINI_MODEL` | `gemini-3.8-flash` | ダイジェスト生成に使うモデル |

## ローカル実行

```bash
npm install
GEMINI_API_KEY=... GMAIL_USER=... GMAIL_APP_PASSWORD=... npm run digest
```
