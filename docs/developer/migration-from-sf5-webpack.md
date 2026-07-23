# Миграция из sf5.webpack

## Provenance

Первичный перенос выполнен из clean worktree:

- repository: legacy `sf5.webpack`;
- revision: `d4d151cce5f0955b1d838e8127ba7555df98d05c`;
- tree: `5616c21d714eeb676933107d879f833f86d0b2c5`;
- independent acceptance: RTL-3J, Node 20 suite `100/100`, две byte-identical
  Core/Component/Utility/Smart build-волны.

Не перенесены `yarn-error.log` и пустой tracked-файл `yarn`: это локальные
legacy artifacts, а не build inputs. История нового GitHub-репозитория не
переписывалась; перенос выполнен поверх его initial commit.

## Совместимость команд

- `core`, `utility`, `comp`, `full`, `dev`, `outline`, `divider`, `editorjs`
  сохранены;
- `plugin` теперь является предупреждающим alias на Component;
- `modal` fail-closed сообщает, что source target отсутствовал уже в принятом
  legacy baseline;
- новые automation должны использовать `build:*`, product runners и `verify`.

## Что не переносится автоматически

- Bitbucket Pipelines: заменён GitHub Actions;
- `/var/www/.../sf5.webpack` и другие machine-specific пути;
- generated writes в `ui`/`ui-smart`;
- release/tag/deploy состояние legacy-репозитория.
