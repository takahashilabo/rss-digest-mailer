# rss-digest-mailer

> **ステータス: 一時停止中（2026-11-12）**
> スケジュール実行を停止し、GitHub Actions上でもワークフローを無効化しています。
> 詳しい経緯は末尾の「今後に向けて」を参照してください。

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
3. Gemini API に「興味関心プロファイル」と「候補記事（タイトル・フィード名・冒頭スニペット）」を渡し、
   5〜15件のidだけを選ばせる（要約や理由付けはさせない。記事本文の冒頭スニペットはarticles.json由来のものをそのまま使う）
4. HTML/テキストメールを組み立てて、Gmail経由で送信
5. メールには記事ごとの直リンクに加えて、**その日の候補記事全件**を一括で既読にする「このダイジェストを全て既読にする」リンクを入れる
   - リンク先は github-rss-reader の `docs/mark-all.html?from=...&to=...`（候補記事の日時範囲を渡すだけで、id一覧はURLに含めない）
   - 開くと、github-rss-readerが使っているのと同じ localStorage (`ghRssReader.readIds`) にその範囲の記事idをまとめて書き込むだけの軽量ページが表示される
   - そのため、既読にするブラウザ/端末は普段 github-rss-reader を見ているものと同じである必要がある（localStorageなのでサーバー同期はされない）

Gemini APIの呼び出しに失敗した場合は、リトライはせず即座に「新しい順に最大15件」を機械的に選ぶフォールバックに切り替わる。

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
| `GEMINI_MODEL` | `gemini-flash-lite-latest` | ダイジェスト生成に使うモデル |

## ローカル実行

```bash
npm install
GEMINI_API_KEY=... GMAIL_USER=... GMAIL_APP_PASSWORD=... npm run digest
```

## 今後に向けて（2026-11-12時点の結論）

このプロジェクトは一旦停止することにした。理由は、ダイジェスト化してまで選別するほどの記事量ではなく、
「コストをかけずに」という制約の中でのAI選別は、労力に見合うほどの精度向上が見込めなかったため。

- 無料枠のGemini（軽量モデル、リトライなし、要約なし）という制約下では、たまに動いても
  「それなり」止まりで、「劇的に良い提案をしてくれる」レベルには届かない
- 本気でやるなら、課金前提のより強力なモデル・より丁寧なプロンプト設計・十分な試行錯誤の時間が必要になりそうで、
  今回のRSSの記事量に対してその投資は見合わないと判断した

再開するなら、以下のような方向性を検討する価値がある：

- そもそもAIによる自動選別をやめ、RSS Reader側のUI改善（検索・フィルタ・興味カテゴリの色分けなど）で
  人間が素早く判断できるようにする方向に倒す（実際、今回はこちらに舵を切った）
- どうしてもAI選別を続けたいなら、課金前提でモデル・プロンプトにきちんと投資する
- Gemini無料枠依存をやめ、他の無料〜低コストな手段（ルールベースのキーワードマッチなど）に戻す
