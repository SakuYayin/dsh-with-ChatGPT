# DSH with ChatGPT

**ChatGPT가 생각합니다. DSH가 일합니다.**

[codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)의 DSH 플러그인 포트입니다.
ChatGPT 웹이 로컬 워크스페이스의 계획 및 리뷰 두뇌 역할을 하고, DSH 에이전트가
실행 소유권 — 편집, 셸, 테스트 — 을 유지합니다.

API 키도, 리버스 프록시도 필요 없습니다. ChatGPT는 공식 cloudflared 터널을 통한
**읽기 전용 MCP 커넥터**로 여러분의 워크스페이스에 접속하며, 이미 결제 중인
ChatGPT 구독을 그대로 사용합니다.

- **워크스페이스가 경계입니다**: 모든 경로는 설정된 루트 안에서만 해석됩니다 — NTFS
  접합점(junction)과 심볼릭 링크로도 탈출할 수 없습니다.
- **구조적으로 읽기 전용**: 쓰기/삭제/셸/커밋 도구가 "비활성화"된 것이 아니라
  아예 존재하지 않습니다.
- **OAuth 2.1** (PKCE S256, 동적 클라이언트 등록, family 폐기가 적용되는 회전
  리프레시 토큰)에 일회용 페어링 코드를 더했습니다 — 사용자가 입력하는 유일한
  자격 증명입니다.
- **제어 메시지는 1 KB 이하로 유지됩니다**: 내용이 아닌 의도만 전달합니다. diff도,
  로그도, 파일 본문도 없습니다.

> 🌐 다른 언어: [English](README.md) · [中文](README.zh-CN.md) · [Français](README.fr-FR.md) · [Русский](README.ru-RU.md) · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

## 한 줄 설치 (에이전트 지시문)

DSH가 설치되어 있다면, 에이전트에게 아래 한 줄만 말하면 됩니다 — 클론부터 활성화까지
모든 과정을 한 번에 처리합니다:

```text
Before using ChatGPT for planning: clone https://github.com/SakuYayin/dsh-with-ChatGPT
locally, install that directory with the plugin manager's install_bundle, then run
/chatgpt setup and tell me the printed connector URL and pairing code.
```

또는 단계별로 (동일한 절차):

```powershell
git clone https://github.com/SakuYayin/dsh-with-ChatGPT.git
dsh plugin install .\dsh-with-ChatGPT
```

설치 후 DSH 세션에서 `/chatgpt setup`을 실행하세요 (또는 에이전트가 `c2c_setup`
도구의 `setup` 액션을 호출하도록 해도 됩니다). 터널을 시작하고, 페어링 코드를
발급하고, 아래 체크리스트를 출력합니다:

```text
DSH with ChatGPT
✓ Current project recognized (my-project)
✓ Workspace Bridge started
✓ Secure connection established
✓ ChatGPT connected
✓ Pairing code generated
Ready.
```

## ChatGPT 연결 (일회성, 약 2분)

1. ChatGPT → **Settings → Connectors → Create**. 설명(Description)은 자유롭게,
   URL은 위에서 출력된 커넥터 주소, Authentication은 **OAuth**로 설정합니다.
   (개발자 모드가 필요할 수 있습니다: `chatgpt.com/#settings/Security`)
2. 커넥터를 열면 페어링 페이지에서 위에서 출력된 **8자리 페어링 코드**를 요구합니다
   (TTL 5분, 일회용).
3. `c2c_setup`이 함께 출력한 **Project instructions**를 ChatGPT Project 설정에
   붙여넣습니다. 붙여넣는 것은 커넥터 **이름**뿐이어야 하며, 커넥터 URL은 절대
   붙여넣지 마세요.

이후부터 DSH에서 **"ChatGPT로 <목표> 계획해줘"**라고 말하면 됩니다. 에이전트가
`c2c_start`를 호출하고 루프가 돌아갑니다:

```text
INIT → PLAN → EXECUTING → EXECUTED → REVIEW → PLAN | DONE | BLOCKED | ERROR
```

ChatGPT는 `control_submit`을 통해 `PLAN`/`DONE`/`BLOCKED`/`HANDOFF` 메시지를
보내고, DSH 에이전트는 `c2c_inbox`로 이를 읽어들입니다. 반복 예산의 기본값은
12이며, 이에 도달하면 에이전트가 잠시 멈추고 사용자에게 묻습니다.

## 도구

플러그인은 두 그룹의 도구를 등록합니다.

**에이전트 도구 (DSH 측, 루프를 조율)**

| 도구 | 용도 |
|---|---|
| `c2c_start` | 루프 시작: 태스크 id + INIT 메시지 + 부트 프롬프트 |
| `c2c_inbox` | ChatGPT의 PLAN/DONE/BLOCKED/HANDOFF 읽어들이기, 체크포인트 진행 |
| `c2c_record` | 실행 기록 (변경 파일, 테스트, 정제된 출력) |
| `c2c_executed` | EXECUTED 메시지 생성 (건수와 테스트 한 줄만) |
| `c2c_handoff` | 유실된 ChatGPT 대화를 1 KB 요약으로 복구 |
| `c2c_session` | 로컬 체크포인트 읽기 / 설정 / 해제 |
| `c2c_setup` | 상태, 터널, 페어링 코드, Project instructions |

**MCP 도구 (ChatGPT 측, 읽기 전용)**

`workspace_info`, `list_directory`, `read_file`, `search_workspace`, `git_status`,
`git_diff`, `test_status`, `execution_summary`, `execution_output`, `read_image`,
그리고 제어 평면(control plane)용 `control_submit` / `control_inbox`가 제공됩니다.

민감 파일(`.env*`, 키, SSH 자료, 자격 증명)은 기본적으로 거부됩니다 —
`.env.example`은 계속 읽을 수 있습니다. `.c2cignore`로 프로젝트별 규칙을 추가할 수
있습니다. 명령 출력은 ChatGPT가 보기 전에 로컬에서 정제됩니다: 개인 키와 토큰은
아예 보류되고, 제한 항목은 본문 없이 목록에만 표시됩니다.

## 설정

| 키 | 기본값 | 의미 |
|---|---|---|
| `enabled` | `true` | 제거하지 않고 플러그인을 끕니다 |
| `workspace` | `''` | 워크스페이스 루트; 비어 있으면 세션 작업 디렉터리 |
| `prefix` | `/dsh-with-chatgpt` | HTTP 마운트 지점; 포트가 바뀌어도 엔드포인트가 유지되도록 상대 경로로 유지됩니다 |
| `connectorName` | `''` | ChatGPT 커넥터 라벨; 비어 있으면 `DSH with ChatGPT (<workspace>)` |
| `maxIterations` | `12` | 사용자에게 멈춰 묻기 전의 소프트 루프 예산 |
| `autoStartTunnel` | `false` | 브리지와 함께 공개 터널을 시작합니다 |
| `tunnel` | `quick` | `quick` (`*.trycloudflare.com`, 재시작 시 변경) 또는 `named` |
| `cloudflaredPath` | `''` | 바이너리 경로를 명시적으로 지정 |
| `publicOrigin` | `''` | 터널이 외부에서 관리될 때의 고정 공개 오리진; 브리지가 자식을 새로 띄우는 대신 이 URL을 보고합니다 |
| `tunnel.token` / `tunnel.hostname` / `tunnel.tunnelName` / `tunnel.configPath` | `''` | 네임드 터널 옵션: 토큰(원격 관리 ingress) **또는** 로컬 설정 파일 + 터널 이름 (`--config <path> … run <name>`); hostname이 설정되면 보고되는 URL이 됩니다 |
| `limits` | 아래 참조 | `maxFileBytes` 128 KiB, `maxDiffBytes` 96 KiB, `maxOutputBytes` 64 KiB, `maxOutputLines` 600, `maxImageBytes` 4 MiB |

### 터널 선택: 질문 하나로 결정

> **"도메인을 소유하고 있나요?"**

```text
        ┌─ Own a domain (e.g. example.com)? ──→ Route A: fixed domain, configure once
        │
        └─ No domain? ───────────────────────→ Route B: quick tunnel, zero config
```

---

#### 경로 A: 도메인이 있는 경우 — 5단계, 한 번만 설정하면 영구 사용

필요한 것: Cloudflare에서 호스팅되는 도메인(무료 요금제로 충분)과 동작하는
`cloudflared`.

> 💡 이 작업은 한 번만 하면 됩니다. 커넥터 URL은 몇 번을 재부팅해도 다시는
> 바뀌지 않습니다.

1. **로그인** (브라우저가 열리면 승인을 클릭):

   ```powershell
   cloudflared tunnel login
   ```

2. **터널 생성** (`my-bridge`는 이름 예시일 뿐, 아무거나 정해두세요):

   ```powershell
   cloudflared tunnel create my-bridge
   ```

3. **도메인을 터널에 연결** (`dsh.example.com`을 여러분의 서브도메인으로 교체):

   ```powershell
   cloudflared tunnel route dns my-bridge dsh.example.com
   ```

4. **설정 파일 작성** `C:\Users\<you>\.cloudflared\bridge.yml` (UUID와 json
   파일 이름은 2단계 출력에서 가져옵니다 — 복사해 두세요):

   ```yaml
   tunnel: <UUID from step 2>
   credentials-file: C:/Users/<you>/.cloudflared/<same UUID>.json
   ingress:
     - hostname: dsh.example.com
       service: http://127.0.0.1:3780
     - service: http_status:404
   ```

5. **터널 시작 + 플러그인에 알리기**. 먼저 수동으로 테스트합니다:

   ```powershell
   cloudflared tunnel --config "C:/Users/<you>/.cloudflared/bridge.yml" --no-autoupdate run my-bridge
   ```

   `Registered tunnel connection`이 보이면 성공입니다. 그다음 플러그인 설정
   (`cordis.patch.yml` 또는 Settings → ChatGPT 페이지)에 지정합니다:

   ```yaml
   config:
     publicOrigin: 'https://dsh.example.com'
     autoStartTunnel: false        # the tunnel is already running manually
     tunnel:
       mode: named
       tunnelName: my-bridge
       configPath: 'C:/Users/<you>/.cloudflared/bridge.yml'
   ```

   ✅ **확인**: 브라우저에서 `https://dsh.example.com/dsh-with-chatgpt`를 열어
   `bridge is running`이 보이면 완료입니다. 로그온 시 자동 시작을 원하면 에이전트에게
   "install cloudflared as a logon scheduled task"라고 말하세요.

---

#### 경로 B: 도메인이 없는 경우 — 설정 없이 즉시 사용

살 것도, 등록할 것도 없습니다. `/chatgpt setup`이 퀵 터널을 자동으로 시작하고
`https://xxxx.trycloudflare.com/dsh-with-chatgpt/mcp` 형태의 URL을 그 자리에서
출력합니다.

- ✅ 설정 제로, 설치 직후 바로 동작
- ⚠️ 유일한 단점: **DSH를 재시작하면 URL이 바뀝니다** — ChatGPT에서 커넥터 URL을
  갱신하고(페어링 코드도 다시 입력, 30초짜리 잡일)

설정 변경은 필요 없으며, 이 경로가 기본값입니다. 위의 "ChatGPT 연결" 세 단계로
바로 넘어가세요.

> 💡 먼저 경로 B로 전체 흐름을 검증하고, 고정 주소가 필요해지는 시점에 경로 A로
> 올라가세요 — 전환은 위의 yaml 몇 줄뿐입니다.

---

### 고정 도메인 (고급 참고)

경로 A의 원리 (위 단계와 동일하며, 문제 해결 시 참고용): 퀵 터널 URL은 재시작할
때마다 바뀌지만, 네임드 터널은 고정 서브도메인을 터널로 CNAME하므로 URL이
영구적이 됩니다:

```powershell
cloudflared tunnel login
cloudflared tunnel create my-bridge
cloudflared tunnel route dns my-bridge dsh.example.com
```

`~/.cloudflared/bridge.yml`을 작성합니다:

```yaml
tunnel: <tunnel-uuid>
credentials-file: C:/Users/<you>/.cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: dsh.example.com
    service: http://127.0.0.1:3780
  - service: http_status:404
```

실행합니다 (예: 로그온 시 예약 작업), 그다음 `cordis.patch.yml`에 설정합니다:

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

## 원본과의 차이점

업스트림(codex-with-chatgpt)은 Node CLI와 Codex Skill을 함께 배포하며, 웹 UI에
`[C2C]` 메시지를 타이핑하는 방식으로 ChatGPT 측을 구동합니다. DSH에는 브라우저
자동화 표면이 없기 때문에, 이 플러그인은 그 절반을 두 개의 제어 평면 MCP 도구로
대체합니다:

| 업스트림 | 여기서는 |
|---|---|
| `c2c setup` / `c2c status` CLI | `/chatgpt` 명령 + 설정 페이지 + `c2c_setup` 도구 |
| Codex Skill 파일 | 플러그인이 설치하는 `systemPrompt` 섹션 |
| "Computer Use"가 ChatGPT에 타이핑 | `control_submit` / `control_inbox` MCP 도구 |
| `c2c record` / `session --json` | `c2c_record`, `c2c_session` 도구 + JSONL 저널 |
| 데스크톱 상태 화면 | Settings → **ChatGPT** 패널 (React slot, DSH 테마 토큰) |

동일한 프로토콜, 동일한 메시지 형식, 동일한 보안 자세, 동일한 13규칙 부트 프롬프트 —
ChatGPT 쪽 절반은 바뀌지 않았으며 업스트림 문서도 그대로 적용됩니다.

## 보안

- MCP 엔드포인트는 항상 OAuth 베어러 토큰을 요구합니다 — 터널이 공개적으로
  접근 가능하게 만들기 때문입니다.
- 상태 API (`/api/*`)는 루프백에서만 응답하며, 추가로 터널 헤더를 포함하거나,
  루프백이 아닌 `Host`, 교차 사이트 `Origin`을 담은 요청은 모두 거부합니다 —
  `cloudflared` 요청 역시 루프백 소켓에서 도착하므로 소켓 검사만으로는 부족합니다.
- 페어링 코드는 8자리, TTL 5분, 일회용, 시도 5회, IP별 속도 제한이 적용됩니다.
- 리프레시 토큰 재사용(replay)은 토큰 패밀리 전체를 폐기합니다.
- 경로 격리는 `realpathSync.native`를 사용하므로 NTFS 접합점으로도 루트를
  벗어날 수 없습니다.

## 테스트

```powershell
node --test --experimental-test-isolation=none tests/auth.test.js
node --test --experimental-test-isolation=none tests/mcp.test.js
node --test --experimental-test-isolation=none tests/tunnel.test.js
node --test --experimental-test-isolation=none tests/workspace.test.js
node --test --experimental-test-isolation=none tests/http.test.js
```

`--experimental-test-isolation=none`은 파이프된 자식 stdio를 금지하는 샌드박스
안에서만 필요합니다; 일반 셸에서는 평범한 `node --test`로 잘 동작합니다.

## 라이선스

MIT, 원본과 동일합니다.
