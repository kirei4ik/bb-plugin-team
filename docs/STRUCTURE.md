# Карта проекта Team

Перед продолжением: [принятые решения](PROJECT-CONTEXT.md) и последняя передача
в задаче Beads. Перед завершением: [порядок закрытия сессии](SESSION-CLOSE.md).

## Где что лежит

```text
bb-plugin-team/
├── src/
│   ├── app/            интерфейс BB и компоненты Team
│   ├── server/         команды, RPC, задачи и управление исполнением
│   ├── host/           операции на рабочем хосте
│   └── shared/         общие схемы, типы, тексты и шаблоны
├── tests/
│   ├── unit/           схемы, политики, форматирование и разбор ответов
│   ├── integration/    SDK, трекеры, сессии, Git и Beads
│   └── ui/             интерфейс через тестовый runtime BB
├── docs/               внутренняя документация; эта карта
├── examples/teams/     примеры конфигураций команд
├── skills/team/        инструкция плагина для агентов
├── assets/             иконки
├── package.json        зависимости, команды и точки входа BB
└── dist/               результат сборки, не исходники; игнорируется Git
```

В корне также остаются README на двух языках, CHANGELOG, LICENSE,
`tsconfig.json` и lock-файл зависимостей. `PLUGIN_OVERVIEW.md` и его русская
версия нужны описанию плагина: BB ожидает обзор рядом с `package.json`.
`node_modules/`, локальная `.beads/` и служебные файлы Git не перемещаются.

## С чего начинать изменение

| Задача | Начальная точка |
| --- | --- |
| Команды CLI, RPC, события BB | `src/server/server.ts` |
| Панель Team и настройки | `src/app/app.tsx` |
| Хостовые операции Beads, Git, чтение квот | `src/host/host.ts` |
| Контракт RPC с рабочим хостом | `src/shared/host-contract.ts` |
| Чтение конфига команды и подготовка окружения | `src/server/core.ts` |
| Выбранный трекер и встроенные задачи | `src/server/tracker.ts`, `tasks.ts` |
| Смена сессии и передача состояния | `src/server/sessions.ts`, `checkpoint.ts` |
| Отложенное продолжение через очередь BB | `src/server/deferred-continuation.ts` |
| Учёт запусков и ограничения | `src/server/resource-control.ts` |
| Квоты Ollama/OpenRouter | `src/shared/*-usage.ts` — схемы; `src/host/*-usage-host.ts` — чтение |
| Шаблоны, промпты, язык | `src/shared/templates.ts`, `messages.ts`, `strings.ts` |
| Состояние панели и общие типы | `src/shared/snapshot.ts` |
| Диагностика исполнения и журнал переходов | `src/shared/execution-diagnostic.ts`, `src/server/execution-journal.ts` |
| Пользовательское восстановление | `docs/EXECUTION-RECOVERY.md`, `src/app/session-recovery-card.tsx` |

`shared` содержит код, который нужен нескольким частям плагина. Импорты типов
из серверных модулей допустимы; серверные API и Node.js-код не должны попадать
в исполняемую часть браузера. Здесь нет дополнительных файлов-посредников:
импорты указывают прямо на нужный модуль.

## Разработка и проверки

Работать в отдельном worktree, как предписывает AGENTS.md. Установленный
checkout и исходники worktree — разные каталоги; не переносить локальную базу
Beads и не выполнять `bd init` в worktree.

```bash
npm run typecheck
npm test
npm run build
```

Во время разработки достаточно соответствующей проверки, например:

```bash
npx vitest run tests/unit/openrouter-usage.test.ts
npx vitest run tests/integration/auto-session.test.ts
npx vitest run tests/ui/app.test.tsx
```

Интеграционные проверки создают временные Git/Beads-данные. Тесты используют
SDK fake, не запускают пользовательские модели. Отдельные живые проверки
плагина и аккаунтов требуют явного выбора безопасного сценария.

BB берёт точки входа из `package.json`: `src/server/server.ts`,
`src/host/host.ts`, `src/app/app.tsx`. `npm run build` создаёт привычные
`dist/server.js`, `dist/host.js`, `dist/app.js` и сопутствующие файлы. Не править
`dist` вручную. После разрешённого применения сборки — `bb plugin reload team`.
Push, теги и публикация требуют отдельного разрешения.
