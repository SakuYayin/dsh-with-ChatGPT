# DSH with ChatGPT

**ChatGPT думает. DSH работает.**

Порт плагина [codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt) для DSH:
веб-интерфейс ChatGPT становится мозгом для планирования и ревью вашего локального
рабочего пространства, а DSH-агент сохраняет полную ответственность за исполнение —
правки, shell, тесты.

Без API-ключа и без обратного прокси. ChatGPT получает доступ к вашему рабочему
пространству через **read-only MCP-коннектор** поверх официального туннеля cloudflared,
используя подписку на ChatGPT, за которую вы уже платите.

- **Рабочее пространство — это граница**: любой путь разрешается внутри настроенного
  корня — NTFS-джанкшены и симлинки не могут вырваться наружу.
- **Read-only по построению**: инструменты записи / удаления / shell / коммитов просто
  не существуют, а не «отключены».
- **OAuth 2.1** (PKCE S256, динамическая регистрация клиента, ротация refresh-токенов
  с отзывом семейства) плюс одноразовый код сопряжения — единственный секрет, который
  вводит пользователь.
- **Управляющие сообщения укладываются в 1 КБ**: намерение, но не содержимое. Без
  диффов, без логов, без тел файлов.

> 🌐 Другие языки: [English](README.md) · [中文](README.zh-CN.md) · [Français](README.fr-FR.md) · [Русский](README.ru-RU.md) · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

## Установка одной командой (инструкция для агента)

Когда DSH уже установлен, скажите своему агенту одну строку — она покрывает всё, от
клонирования до включения:

```text
Before using ChatGPT for planning: clone https://github.com/SakuYayin/dsh-with-ChatGPT
locally, install that directory with the plugin manager's install_bundle, then run
/chatgpt setup and tell me the printed connector URL and pairing code.
```

Или по шагам (эквивалентно):

```powershell
git clone https://github.com/SakuYayin/dsh-with-ChatGPT.git
dsh plugin install .\dsh-with-ChatGPT
```

После установки выполните `/chatgpt setup` в сессии DSH (или попросите агента вызвать
действие `setup` инструмента `c2c_setup`). Запускается туннель, создаётся код сопряжения
и печатается такой чек-лист:

```text
DSH with ChatGPT
✓ Current project recognized (my-project)
✓ Workspace Bridge started
✓ Secure connection established
✓ ChatGPT connected
✓ Pairing code generated
Ready.
```

## Подключение ChatGPT (однократно, ~2 минуты)

1. ChatGPT → **Settings → Connectors → Create**. Описание — произвольное, URL = адрес
   коннектора, напечатанный выше, Authentication = **OAuth**
   (может потребоваться режим разработчика: `chatgpt.com/#settings/Security`).
2. Откройте коннектор; страница сопряжения попросит **8-значный код сопряжения**,
   напечатанный выше (TTL 5 минут, одноразовый).
3. Вставьте **Project instructions** (их также печатает `c2c_setup`) в настройки
   ChatGPT Project. Вставляйте только **имя** коннектора — никогда не вставляйте URL
   коннектора.

Дальше просто скажите в DSH: **«Use ChatGPT to plan <goal>»**. Агент вызывает
`c2c_start`, и запускается цикл:

```text
INIT → PLAN → EXECUTING → EXECUTED → REVIEW → PLAN | DONE | BLOCKED | ERROR
```

ChatGPT отправляет `PLAN`/`DONE`/`BLOCKED`/`HANDOFF` через `control_submit`; DSH-агент
забирает их с помощью `c2c_inbox`. Бюджет итераций по умолчанию — 12; по его исчерпании
агент приостанавливается и спрашивает.

## Инструменты

Плагин регистрирует две группы.

**Инструменты агента (сторона DSH, оркестрация цикла)**

| Инструмент | Назначение |
|---|---|
| `c2c_start` | Запустить цикл: id задачи + сообщение INIT + загрузочный промпт |
| `c2c_inbox` | Забрать PLAN/DONE/BLOCKED/HANDOFF от ChatGPT, продвинуть чекпоинт |
| `c2c_record` | Записать результат итерации (файлы, тесты, санитизированный вывод) |
| `c2c_executed` | Собрать сообщение EXECUTED (только счётчики и строка тестов) |
| `c2c_handoff` | Восстановить потерянную беседу ChatGPT с помощью брифа на 1 КБ |
| `c2c_session` | Прочитать / установить / очистить локальный чекпоинт |
| `c2c_setup` | Статус, туннель, код сопряжения, Project instructions |

**MCP-инструменты (сторона ChatGPT, read-only)**

`workspace_info`, `list_directory`, `read_file`, `search_workspace`, `git_status`,
`git_diff`, `test_status`, `execution_summary`, `execution_output`, `read_image`,
плюс `control_submit` / `control_inbox` для управляющей плоскости.

Чувствительные файлы (`.env*`, ключи, SSH-материал, учётные данные) по умолчанию
запрещены — `.env.example` остаётся читаемым. `.c2cignore` добавляет правила для
конкретного проекта. Вывод команд санитизируется локально, прежде чем ChatGPT его
увидит: приватные ключи и токены скрываются полностью, ограниченные элементы
отображаются в списках без тела.

## Конфигурация

| Ключ | По умолчанию | Значение |
|---|---|---|
| `enabled` | `true` | Выключить плагин, не удаляя его |
| `workspace` | `''` | Корень рабочего пространства; пусто = рабочая директория сессии |
| `prefix` | `/dsh-with-chatgpt` | Точка HTTP-монтирования; относительная, чтобы эндпоинт переживал смену порта |
| `connectorName` | `''` | Отображаемое имя коннектора ChatGPT; пусто = `DSH with ChatGPT (<workspace>)` |
| `maxIterations` | `12` | Мягкий бюджет цикла, после которого агент делает паузу для пользователя |
| `autoStartTunnel` | `false` | Запускать публичный туннель вместе с бриджем |
| `tunnel` | `quick` | `quick` (`*.trycloudflare.com`, меняется при перезапуске) или `named` |
| `cloudflaredPath` | `''` | Явный путь к бинарнику |
| `publicOrigin` | `''` | Фиксированный публичный origin, когда туннель управляется извне; бридж отдаёт этот URL, вместо того чтобы запускать собственный дочерний процесс |
| `tunnel.token` / `tunnel.hostname` / `tunnel.tunnelName` / `tunnel.configPath` | `''` | Опции именованного туннеля: токен (ingress под удалённым управлением) **или** локальный конфиг + имя туннеля (`--config <path> … run <name>`); hostname задаёт отдаваемый URL |
| `limits` | см. ниже | `maxFileBytes` 128 КиБ, `maxDiffBytes` 96 КиБ, `maxOutputBytes` 64 КиБ, `maxOutputLines` 600, `maxImageBytes` 4 МиБ |

### Выбор туннеля: ответьте на один вопрос

> **«Есть ли у меня свой домен?»**

```text
        ┌─ Own a domain (e.g. example.com)? ──→ Route A: fixed domain, configure once
        │
        └─ No domain? ───────────────────────→ Route B: quick tunnel, zero config
```

---

#### Маршрут A: у вас есть домен — 5 шагов, настраивается один раз навсегда

Что понадобится: домен, размещённый на Cloudflare (бесплатного тарифа достаточно), и
работающий `cloudflared`.

> 💡 Это делается один раз. URL коннектора больше никогда не меняется, сколько бы раз
> вы ни перезагружались.

1. **Авторизуйтесь** (откроется браузер; нажмите разрешить):

   ```powershell
   cloudflared tunnel login
   ```

2. **Создайте туннель** (`my-bridge` — просто имя, выберите любое и запомните его):

   ```powershell
   cloudflared tunnel create my-bridge
   ```

3. **Направьте домен на туннель** (замените `dsh.example.com` на свой поддомен):

   ```powershell
   cloudflared tunnel route dns my-bridge dsh.example.com
   ```

4. **Напишите конфиг** `C:\Users\<you>\.cloudflared\bridge.yml` (UUID и имя json-файла
   берутся из вывода шага 2 — скопируйте их):

   ```yaml
   tunnel: <UUID from step 2>
   credentials-file: C:/Users/<you>/.cloudflared/<same UUID>.json
   ingress:
     - hostname: dsh.example.com
       service: http://127.0.0.1:3780
     - service: http_status:404
   ```

5. **Запустите туннель + сообщите плагину**. Сначала проверьте вручную:

   ```powershell
   cloudflared tunnel --config "C:/Users/<you>/.cloudflared/bridge.yml" --no-autoupdate run my-bridge
   ```

   Увидели `Registered tunnel connection` — успех. Затем задайте конфигурацию плагина
   (`cordis.patch.yml` или Settings → страница ChatGPT):

   ```yaml
   config:
     publicOrigin: 'https://dsh.example.com'
     autoStartTunnel: false        # the tunnel is already running manually
     tunnel:
       mode: named
       tunnelName: my-bridge
       configPath: 'C:/Users/<you>/.cloudflared/bridge.yml'
   ```

   ✅ **Проверка**: откройте `https://dsh.example.com/dsh-with-chatgpt` в браузере;
   увидели `bridge is running` — готово. Хотите автозапуск при входе в систему?
   Скажите агенту: «install cloudflared as a logon scheduled task».

---

#### Маршрут B: без домена — нулевая настройка, работает сразу

Ничего покупать и регистрировать не нужно. `/chatgpt setup` автоматически запускает
quick-туннель и сразу печатает URL вида
`https://xxxx.trycloudflare.com/dsh-with-chatgpt/mcp`.

- ✅ Нулевая настройка, работает сразу после установки
- ⚠️ Единственный нюанс: **URL меняется при перезапуске DSH** — обновите URL коннектора
  в ChatGPT (и заново введите код сопряжения, 30-секундная рутина)

Изменения конфигурации не нужны; этот маршрут — по умолчанию. Сразу переходите к трём
шагам «Подключение ChatGPT» выше.

> 💡 Сначала прогоните маршрут B, чтобы проверить весь поток целиком; переходите на
> маршрут A в любой момент, когда захотите фиксированный адрес — переключение сводится
> к нескольким yaml-строкам выше.

---

### Фиксированный домен (справка для продвинутых)

Обоснование маршрута A (эквивалент шагов выше, пригодится при диагностике): URL
quick-туннеля меняется при каждом перезапуске, тогда как именованный туннель
привязывает (CNAME) фиксированный поддомен к вашему туннелю, делая URL постоянным:

```powershell
cloudflared tunnel login
cloudflared tunnel create my-bridge
cloudflared tunnel route dns my-bridge dsh.example.com
```

Напишите `~/.cloudflared/bridge.yml`:

```yaml
tunnel: <tunnel-uuid>
credentials-file: C:/Users/<you>/.cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: dsh.example.com
    service: http://127.0.0.1:3780
  - service: http_status:404
```

Запустите его (например, задачей планировщика при входе в систему), затем задайте в
`cordis.patch.yml`:

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

## Отличия от оригинала

В оригинале (codex-with-chatgpt) поставляется Node CLI вместе с Codex Skill, а сторона
ChatGPT управляется вводом сообщений `[C2C]` в веб-интерфейс. У DSH нет поверхности для
автоматизации браузера, поэтому этот плагин заменяет ту половину двумя MCP-инструментами
управляющей плоскости:

| В оригинале | Здесь |
|---|---|
| CLI `c2c setup` / `c2c status` | Команда `/chatgpt` + страница настроек + инструмент `c2c_setup` |
| Файл Codex Skill | Секция `systemPrompt`, устанавливаемая плагином |
| «Computer Use» вводит текст в ChatGPT | MCP-инструменты `control_submit` / `control_inbox` |
| `c2c record` / `session --json` | Инструменты `c2c_record`, `c2c_session` + журнал JSONL |
| Экран статуса в desktop-версии | Settings → панель **ChatGPT** (React-слот, токены темы DSH) |

Тот же протокол, тот же формат сообщений, та же модель безопасности, тот же
загрузочный промпт на 13 правил — половина ChatGPT не изменилась, и документация
оригинала по-прежнему применима.

## Безопасность

- MCP-эндпоинт всегда требует OAuth bearer-токен — туннель делает его публично доступным.
- State API (`/api/*`) отвечает только на loopback и дополнительно отклоняет любой
  запрос с заголовками туннеля, не-loopback `Host` или кросс-сайтовым `Origin` — запрос
  `cloudflared` тоже приходит с loopback-сокета, так что одной проверки сокета
  недостаточно.
- Коды сопряжения — 8 символов, TTL 5 минут, одноразовые, 5 попыток, rate limit на IP.
- Повторное использование refresh-токена отзывает всё семейство токенов.
- Сдерживание путей использует `realpathSync.native`, поэтому NTFS-джанкшены не могут
  выйти за пределы корня.

## Тесты

```powershell
node --test --experimental-test-isolation=none tests/auth.test.js
node --test --experimental-test-isolation=none tests/mcp.test.js
node --test --experimental-test-isolation=none tests/tunnel.test.js
node --test --experimental-test-isolation=none tests/workspace.test.js
node --test --experimental-test-isolation=none tests/http.test.js
```

`--experimental-test-isolation=none` нужен только внутри песочницы, запрещающей пайп
stdio дочерних процессов; в обычной оболочке прекрасно работает простой `node --test`.

## Лицензия

MIT, как и оригинал.
