# DSH with ChatGPT

**思考するのは ChatGPT。動かすのは DSH。**

[codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt) を DSH プラグインに移植したものです。ChatGPT web がローカルワークスペースの計画・レビューの頭脳となり、DSH エージェントが実行権（編集・シェル・テスト）を保持し続けます。

API キーもリバースプロキシも不要です。ChatGPT は公式の cloudflared トンネル経由の**読み取り専用 MCP コネクタ**を通じてワークスペースにアクセスし、すでに契約済みの ChatGPT サブスクリプションをそのまま使います。

- **ワークスペースが境界です**: すべてのパスは設定されたルート内でのみ解決されます。NTFS ジャンクションやシンボリックリンクでも外へは逃げられません。
- **構造的に読み取り専用**: 書き込み・削除・シェル・コミットのツールは「無効化」されているのではなく、そもそも存在しません。
- **OAuth 2.1**（PKCE S256、動的クライアント登録、ファミリ失効つきローテーティングリフレッシュトークン）に加え、ユーザーが入力するのは 1 回きりのペアリングコードだけです。
- **コントロールメッセージは 1 KB 未満**: 送るのは意図のみで、差分・ログ・ファイル本体は含みません。

> 🌐 その他の言語: [English](README.md) · [中文](README.zh-CN.md) · [Français](README.fr-FR.md) · [Русский](README.ru-RU.md) · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

## ワンコマンドインストール（エージェントへの指示）

DSH をインストールしたら、エージェントに次の 1 行を伝えるだけです。クローンから有効化までをすべてカバーします:

```text
Before using ChatGPT for planning: clone https://github.com/SakuYayin/dsh-with-ChatGPT
locally, install that directory with the plugin manager's install_bundle, then run
/chatgpt setup and tell me the printed connector URL and pairing code.
```

あるいは手順ごと（等価）でも構いません:

```powershell
git clone https://github.com/SakuYayin/dsh-with-ChatGPT.git
dsh plugin install .\dsh-with-ChatGPT
```

インストール後、DSH セッションで `/chatgpt setup` を実行してください（またはエージェントに `c2c_setup` ツールの `setup` アクションを呼び出させます）。トンネルが起動し、ペアリングコードが発行されて、次のチェックリストが表示されます:

```text
DSH with ChatGPT
✓ Current project recognized (my-project)
✓ Workspace Bridge started
✓ Secure connection established
✓ ChatGPT connected
✓ Pairing code generated
Ready.
```

## ChatGPT との接続（1 回のみ、約 2 分）

1. ChatGPT → **Settings → Connectors → Create**。説明は自由記入、URL は上で表示されたコネクタアドレス、認証は **OAuth** とします（開発者モードが必要な場合があります: `chatgpt.com/#settings/Security`）。
2. コネクタを開くと、ペアリングページで上に表示された**8 文字のペアリングコード**を求められます（TTL 5 分、1 回限り）。
3. **Project instructions**（これも `c2c_setup` が表示します）を ChatGPT の Project 設定に貼り付けます。貼り付けるのはコネクタの**名前**だけにしてください。コネクタ URL は絶対に貼らないでください。

以後、DSH で **「Use ChatGPT to plan <goal>」** と言えば、エージェントが `c2c_start` を呼び出してループが回ります:

```text
INIT → PLAN → EXECUTING → EXECUTED → REVIEW → PLAN | DONE | BLOCKED | ERROR
```

ChatGPT は `control_submit` を通じて `PLAN`/`DONE`/`BLOCKED`/`HANDOFF` を送り、DSH エージェントは `c2c_inbox` でそれを受け取ります。イテレーション予算の既定値は 12 で、上限に達するとエージェントは一時停止してユーザーに確認します。

## ツール

プラグインは 2 つのグループを登録します。

**エージェントツール（DSH 側、ループを統括）**

| ツール | 目的 |
|---|---|
| `c2c_start` | ループを開始: タスク ID + INIT メッセージ + ブートプロンプト |
| `c2c_inbox` | ChatGPT の PLAN/DONE/BLOCKED/HANDOFF を取り込み、チェックポイントを進める |
| `c2c_record` | 実行結果を記録（変更ファイル、テスト、サニタイズ済み出力） |
| `c2c_executed` | EXECUTED メッセージを生成（件数とテスト結果行のみ） |
| `c2c_handoff` | 失われた ChatGPT 会話を 1 KB のブリーフで復旧 |
| `c2c_session` | ローカルチェックポイントの読み取り・設定・クリア |
| `c2c_setup` | 状態確認、トンネル、ペアリングコード、Project instructions |

**MCP ツール（ChatGPT 側、読み取り専用）**

`workspace_info`、`list_directory`、`read_file`、`search_workspace`、`git_status`、
`git_diff`、`test_status`、`execution_summary`、`execution_output`、`read_image`、
およびコントロールプレーン用の `control_submit` / `control_inbox`。

機密ファイル（`.env*`、鍵、SSH 素材、認証情報）は既定で拒否されます（`.env.example` は読み取り可能のまま）。`.c2cignore` でプロジェクト固有のルールを追加できます。コマンド出力は ChatGPT が見る前にローカルでサニタイズされ、秘密鍵やトークンは丸ごと隠され、制限対象の項目は本体なしで一覧に現れます。

## 設定

| キー | 既定値 | 意味 |
|---|---|---|
| `enabled` | `true` | アンインストールせずにプラグインを無効化する |
| `workspace` | `''` | ワークスペースのルート。空 = セッションの作業ディレクトリ |
| `prefix` | `/dsh-with-chatgpt` | HTTP マウントポイント。相対パスを保つため、ポートを変更してもエンドポイントは生き続けます |
| `connectorName` | `''` | ChatGPT コネクタの表示名。空 = `DSH with ChatGPT (<workspace>)` |
| `maxIterations` | `12` | ユーザーに確認して一時停止するまでのソフトなループ予算 |
| `autoStartTunnel` | `false` | ブリッジと一緒に公開トンネルを起動する |
| `tunnel` | `quick` | `quick`（`*.trycloudflare.com`、再起動のたびに変わる）または `named` |
| `cloudflaredPath` | `''` | バイナリの明示的なパス |
| `publicOrigin` | `''` | トンネルを外部管理するときの固定公開オリジン。ブリッジは子プロセスを起動する代わりにこの URL を報告します |
| `tunnel.token` / `tunnel.hostname` / `tunnel.tunnelName` / `tunnel.configPath` | `''` | ネームドトンネルのオプション: トークン（リモート管理の ingress）**または**ローカル設定ファイル + トンネル名（`--config <path> … run <name>`）。hostname を設定すると報告される URL になります |
| `limits` | 下記参照 | `maxFileBytes` 128 KiB、`maxDiffBytes` 96 KiB、`maxOutputBytes` 64 KiB、`maxOutputLines` 600、`maxImageBytes` 4 MiB |

### トンネルの選び方: たった 1 つの質問

> **「自分のドメインを持っているか？」**

```text
        ┌─ Own a domain (e.g. example.com)? ──→ Route A: fixed domain, configure once
        │
        └─ No domain? ───────────────────────→ Route B: quick tunnel, zero config
```

---

#### ルート A: ドメインを持っている場合 — 5 ステップ、一度設定すればずっと使える

必要なもの: Cloudflare でホストされたドメイン（無料プランで十分）と動作する `cloudflared`。

> 💡 これは一度だけ行えば OK です。何回再起動しても、コネクタ URL は二度と変わりません。

1. **ログイン**（ブラウザが開くので、認証をクリックします）:

   ```powershell
   cloudflared tunnel login
   ```

2. **トンネルを作成**（`my-bridge` は名前なので何でもよく、覚えておきます）:

   ```powershell
   cloudflared tunnel create my-bridge
   ```

3. **ドメインをトンネルに向ける**（`dsh.example.com` は自分のサブドメインに置き換えます）:

   ```powershell
   cloudflared tunnel route dns my-bridge dsh.example.com
   ```

4. **設定ファイルを書く** `C:\Users\<you>\.cloudflared\bridge.yml`（UUID と json ファイル名はステップ 2 の出力にあります。それをコピーしてください）:

   ```yaml
   tunnel: <UUID from step 2>
   credentials-file: C:/Users/<you>/.cloudflared/<same UUID>.json
   ingress:
     - hostname: dsh.example.com
       service: http://127.0.0.1:3780
     - service: http_status:404
   ```

5. **トンネルを起動してプラグインに伝える**。まず手動でテストします:

   ```powershell
   cloudflared tunnel --config "C:/Users/<you>/.cloudflared/bridge.yml" --no-autoupdate run my-bridge
   ```

   `Registered tunnel connection` が見えれば成功です。次にプラグイン設定をセットします（`cordis.patch.yml` または設定 → ChatGPT ページ）:

   ```yaml
   config:
     publicOrigin: 'https://dsh.example.com'
     autoStartTunnel: false        # the tunnel is already running manually
     tunnel:
       mode: named
       tunnelName: my-bridge
       configPath: 'C:/Users/<you>/.cloudflared/bridge.yml'
   ```

   ✅ **確認**: ブラウザで `https://dsh.example.com/dsh-with-chatgpt` を開き、`bridge is running` が見えれば完了です。ログオン時に自動起動させたい場合は、エージェントにこう伝えます: "install cloudflared as a logon scheduled task"。

---

#### ルート B: ドメインがない場合 — ゼロ設定、すぐに使える

買うものも登録するものも何もありません。`/chatgpt setup` がクイックトンネルを自動で起動し、`https://xxxx.trycloudflare.com/dsh-with-chatgpt/mcp` 形式の URL をその場で表示します。

- ✅ ゼロ設定、インストール直後に動作
- ⚠️ 唯一の注意点: **DSH を再起動すると URL が変わる** — ChatGPT 側でコネクタ URL を更新し、ペアリングコードを再入力する必要があります（30 秒程度の作業です）

設定変更は不要で、このルートが既定です。上記の「ChatGPT との接続」3 ステップへそのまま進んでください。

> 💡 まずルート B でフロー全体を検証し、固定アドレスが必要になったらいつでもルート A にアップグレードできます。切り替えは上記の数行の yaml だけです。

---

### 固定ドメイン（上級者向けリファレンス）

ルート A の背景にある理屈です（上記の手順と等価で、トラブルシュート用）: クイックトンネルの URL は再起動のたびに変わりますが、ネームドトンネルは固定サブドメインをトンネルに CNAME するため URL が恒久化されます:

```powershell
cloudflared tunnel login
cloudflared tunnel create my-bridge
cloudflared tunnel route dns my-bridge dsh.example.com
```

`~/.cloudflared/bridge.yml` を書きます:

```yaml
tunnel: <tunnel-uuid>
credentials-file: C:/Users/<you>/.cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: dsh.example.com
    service: http://127.0.0.1:3780
  - service: http_status:404
```

実行します（例: ログオン時のスケジュールタスク）。その後 `cordis.patch.yml` に設定します:

```yaml
- insert:
    - id: dsh-with-chatgpt
      name: dsh-with-chatgpt
      config:
        publicOrigin: 'https://dsh.example.com'
        autoStartTunnel: false   # an external supervisor owns the tunnel
        tunnel:
          mode: named
          tunnelName: my-bridge
          configPath: 'C:/Users/<you>/.cloudflared/bridge.yml'
```

## オリジナルとの違い

上流（codex-with-chatgpt）は Node CLI と Codex Skill を同梱し、ChatGPT 側を web UI に `[C2C]` メッセージを打ち込むことで操作します。DSH にはブラウザ自動化の面がないため、このプラグインはその半分を 2 つのコントロールプレーン MCP ツールで置き換えました:

| 上流 | こちら |
|---|---|
| `c2c setup` / `c2c status` CLI | `/chatgpt` コマンド + 設定ページ + `c2c_setup` ツール |
| Codex Skill ファイル | プラグインがインストールする `systemPrompt` セクション |
| 「Computer Use」で ChatGPT に入力 | `control_submit` / `control_inbox` MCP ツール |
| `c2c record` / `session --json` | `c2c_record`、`c2c_session` ツール + JSONL ジャーナル |
| デスクトップのステータス画面 | 設定 → **ChatGPT** パネル（React スロット、DSH テーマトークン） |

プロトコルもメッセージ形式もセキュリティ姿勢も 13 ルールのブートプロンプトも同じであり、ChatGPT 側は変更されていないため上流のドキュメントもそのまま適用できます。

## セキュリティ

- MCP エンドポイントは常に OAuth ベアラートークンを要求します — トンネル経由で公開到達可能になるためです。
- ステート API（`/api/*`）はループバックからのみ応答し、さらにトンネルヘッダー、非ループバックの `Host`、クロスサイトの `Origin` を含むリクエストは拒否します — `cloudflared` のリクエストもループバックソケットから届くため、ソケットチェックだけでは不十分だからです。
- ペアリングコードは 8 文字、TTL 5 分、1 回限り、試行 5 回、IP ごとのレート制限つきです。
- リフレッシュトークンのリプレイはトークンファミリ全体を失効させます。
- パス閉じ込めには `realpathSync.native` を使用しており、NTFS ジャンクションでもルートの外へは逃げられません。

## テスト

```powershell
node --test --experimental-test-isolation=none tests/auth.test.js
node --test --experimental-test-isolation=none tests/mcp.test.js
node --test --experimental-test-isolation=none tests/tunnel.test.js
node --test --experimental-test-isolation=none tests/workspace.test.js
node --test --experimental-test-isolation=none tests/http.test.js
```

`--experimental-test-isolation=none` が必要になるのは、パイプされた子プロセスの stdio を禁止するサンドボックス内だけです。通常のシェルでは素の `node --test` がそのまま動きます。

## ライセンス

MIT。オリジナルと同じです。
