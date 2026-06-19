# pi-todo

Project-scoped, personal prioritized inbox list for [pi](https://pi.dev).

## Install

```bash
pi install git:github.com/filipores/pi-todo
```

## Commands

```text
/todo                 show the ranked inbox
/todo <text>          add an inbox entry and prioritize
/todo sort            reprioritize
/todo done <id>       delete an entry
/todo move <id> <n>   set a manual rank
/todo clear           delete all entries after confirmation
/todo setup           choose project context files again
```

Prioritization runs automatically from the current Pi/project context; `/todo setup` only adds extra project files. Data is stored locally under `~/.pi/agent/pi-todo/`.
