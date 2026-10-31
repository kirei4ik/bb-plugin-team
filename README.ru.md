# bb-plugin-team

Команды агентов по ролям для [bb](https://getbb.app): руководитель планирует и
принимает работу, исполнители (разработчик, младший разработчик, тестировщик,
писатель и другие) отчитываются ему. В проекте может быть несколько команд,
команды создаются из шаблонов.

English version: [README.md](README.md).

## Установка

```bash
bb plugin install git:https://github.com/kirei4ik/bb-plugin-team.git@^0.2.0
# или для разработки — из локальной папки:
bb plugin install /путь/к/bb-plugin-team
```

## Быстрый старт

Через панель **Team** в навигации:

1. Панель показывает все проекты тремя группами — *с командами*, *можно
   создать команду*, *сейчас нельзя создать* (с причиной), — по алфавиту и с
   поиском сверху.
2. Откройте проект, выберите шаблон, поправьте роли, провайдеров и модели и
   нажмите **Создать команду**. Роль с выключенным провайдером блокирует
   создание.
3. Команды проекта показываются деревом: руководитель → исполнители →
   помощники. В каждой строке — статус, модель и текущий пакет работ. Клик по
   строке открывает действия: открыть тред, написать, выдать пакет, остановить.

Через CLI (в треде проекта или с `--project`):

```bash
bb team init --team core --template dev   # .bb/teams/core.yaml + промпты ролей
bb team doctor --team core                # провайдеры, окружения, промпты, git
bb team create --team core                # создать треды
bb team status                            # все команды проекта
```

## Команды, файлы и git

| Что | Где |
|---|---|
| Конфиг команды | `.bb/teams/<команда>.yaml` (старый `.bb/team.yaml` = команда `main`) |
| Промпты ролей | `.bb/teams/<команда>/<роль>.md` |
| Держит команду вне git | `.bb/teams/.gitignore` |

Новые команды по умолчанию **не версионируются**. `bb team version on --team core`
(или галочка в панели) включает хранение в git, `off` выключает. Если корневой
`.gitignore` игнорирует весь `.bb/`, сначала замените строку на `.bb/*` и
`!.bb/teams/` — плагин об этом подскажет.

Названия тредов задаёт настройка **формат названия**, по умолчанию
`👥 {team} · {role}`; имя команды не пишется, пока в проекте одна команда. У
каждой команды своя секция в сайдбаре (`Team`, `Team · qa`).

## Шаблоны

Встроенные: `dev` (руководитель, разработчик, младший разработчик на дешёвой
модели, тестировщик — по умолчанию, настроен на качество кода при малом
бюджете токенов), `qa`, `docs`, `product` (менеджер, аналитик, писатель).
Шаблоны общие для всех проектов сервера:

- Настройки → Team: редактирование, дублирование встроенных, новый шаблон из
  видов ролей с готовыми промптами.
- CLI: `bb team template list | show | save | delete`;
  `save <id> --kinds lead,developer,junior,tester`, `--from-team core`,
  `--from-template dev`.
- Панель: **⋯ → Сохранить как шаблон** у команды.

Роль без `prompt`/`promptFile` получает короткий встроенный промпт своего
вида `kind` (lead, developer, junior, tester, reviewer, writer, analyst,
devops, manager; `developer-2` считается `developer`).

## Работа с командой

```bash
bb team task add developer "Форма входа" --note "критерии" --send   # пакет с учётом
bb team task update 3 --status review     # исполнитель: готово, ждёт ревью
bb team task done 3                       # только руководитель
bb team tell tester --message "перезапусти smoke"   # или all
bb team add-role junior --provider pi --model qwen3
bb team add-role reviewer --thread thr_…      # взять свободный тред проекта
bb team pause [--stop] / bb team resume
bb team stop [<роль>|all]
bb team replace developer [--keep]        # новый тред с передачей дел
bb team report --out "$BB_THREAD_STORAGE/team.html"   # сводка для чата (inline-vis)
bb team retitle                           # применить формат названий заново
```

- **Помощники**: тред, созданный под тредом команды, становится помощником
  этой роли.
- **Пауза** придерживает сообщения агентов и плагина исполнителям; сообщения
  человека не задерживаются.
- **notifyOn: [idle, error]** у роли будит руководителя после её ходов.
- `bb team create` можно запускать повторно: он создаёт только недостающие
  роли и заново привязывает исполнителей, потерявших руководителя.

## Справочник конфига

Пример и описание полей — в [README.md](README.md#config-reference) и в
[examples/teams](examples/teams). Поля роли: `name`, `kind`, `title`,
`provider`, `model`, `reasoningLevel`, `serviceTier`, `permissionMode`,
`environment`, `parentNotifications`, `lead`, `enabled`, `notifyOn`,
`threadId`, `prompt` / `promptFile`. Подстановки в промптах: `{{teamName}}`,
`{{leadThreadId}}`, `{{leadThreadRef}}`, `{{role.<имя>.threadId}}`,
`{{role.<имя>.ref}}`, `{{projectId}}`, `{{workspacePath}}`, `{{vars.<имя>}}`.

## Настройки

| Настройка | По умолчанию | Что делает |
|---|---|---|
| `language` | `en` | язык CLI, панели и шаблонов (`en`, `ru`) |
| `teamSection` | вкл | своя секция сайдбара у каждой команды |
| `roster` | вкл | сообщение руководителю с составом после create |
| `titleFormat` | `👥 {team} · {role}` | названия тредов команды |

## Разработка

```bash
npm install
npm test          # vitest: логика, CLI на фейковом хосте, панель в jsdom
npm run typecheck
bb plugin build && bb plugin reload team
```

Лицензия MIT, см. [LICENSE](LICENSE).
