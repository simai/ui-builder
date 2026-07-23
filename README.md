# Simai Framework UI Builder

Воспроизводимая build-system для Core, Component, Utility и Smart-контуров
Simai Framework. Репозиторий перенесён из legacy `sf5.webpack`; source of truth
компонентов остаётся в `ui-loader`, а `ui` и `ui-smart` остаются generated
distribution и не редактируются вручную.

## Runtime

- Node.js `20.19.5` для acceptance и CI; поддерживаемый минимум — `20.19.0`.
- Yarn Classic `1.22.22`.
- Webpack `5.108.4`.
- committed `yarn.lock` привязан к независимо принятому builder baseline
  `sf5.webpack@d4d151cce5f0955b1d838e8127ba7555df98d05c`.

```bash
corepack enable
yarn install --frozen-lockfile --ignore-scripts --non-interactive
yarn run verify
```

`yarn run` перед `verify` и `check` обязателен: в Yarn 1 слово `check` также
является встроенной командой.

## Проверки

```bash
yarn run check:repository
yarn run check:rtl-postcss
yarn run test:reproducibility
yarn run verify
```

`verify` проверяет repository/runtime contract, сохранность logical CSS после
direction-aware fallback, deterministic IDs, packaging, gzip и две реальные
fixture-сборки всех четырёх продуктовых контуров.

Полная двухволновая проверка на конкретном `ui-loader` запускается только в
новой временной директории:

```bash
node scripts/verify-product-reproducibility.cjs \
  /absolute/path/to/ui-loader \
  /absolute/path/to/new-workspace
```

Она создаёт по два независимых frozen runtime для builder/source, собирает
Core, Component, Utility и Smart и требует byte-identical manifests. Результат
пишется в `<workspace>/report.json`; checkout `ui`, `ui-smart` не нужен.

## Product runners

Runners принимают только абсолютные пути и требуют новый, ещё не существующий
output root:

```bash
SF_BUILDER_DEPENDENCY_ROOT=/absolute/path/to/builder-runtime \
SF_SOURCE_DEPENDENCY_ROOT=/absolute/path/to/source-runtime \
node scripts/run-component-utility-product-build.cjs \
  component \
  /absolute/path/to/ui-builder \
  /absolute/path/to/ui-loader/src \
  /absolute/path/to/new-output \
  /absolute/path/to/diagnostics.json
```

Для Core и Smart используются соответственно
`run-core-product-build.cjs` и `run-smart-product-build.cjs`. Frozen runtime
готовит `prepare-frozen-dependency-runtime.cjs`.

Legacy compatibility materialization включается только полным набором:

- `SF_LEGACY_COMPATIBILITY_ROOT`;
- `SF_LEGACY_COMPATIBILITY_MANIFEST`;
- `SF_LEGACY_COMPATIBILITY_REVISION`.

Неполный или не совпадающий набор завершается fail-closed.

## Команды разработки

| Команда | Назначение |
| --- | --- |
| `yarn build:core` | Core, normal + minified |
| `yarn build:component` | Component, normal + minified |
| `yarn build:utility` | Utility, normal + minified |
| `yarn build:all` | Core + Component + Utility, one-shot |
| `yarn watch` | те же три контура в watch-mode |

Legacy aliases `full`, `core`, `utility`, `comp`, `plugin`, `dev`, `outline`,
`divider` и `editorjs` сохранены. `plugin` направляется в Component с
предупреждением. Источник отсутствующего legacy-target `modal` не входил в
принятый builder, поэтому команда сохранена как явный fail-closed, а не как
скрытая неправильная сборка.

Для legacy webpack-configs заполните безопасную локальную `.env` по
[`.env.example`](.env.example). Product runners `.env` не требуют.

## GitHub Actions

- `CI` выполняет frozen install и `yarn run verify` для push/PR.
- `Product reproducibility` вручную принимает exact `ui-loader` ref и сохраняет
  две build-волны как artifact. Для private `simai/ui-loader` нужен repository
  secret `UI_LOADER_READ_TOKEN` с read-only Contents access.

## Документация

- [Карта документации](docs/README.md)
- [Архитектура и границы](docs/developer/architecture.md)
- [Миграция из sf5.webpack](docs/developer/migration-from-sf5-webpack.md)
- [Политика зависимостей](docs/developer/dependency-policy.md)

Миграция builder не означает завершение RTL acceptance. Общая готовность LTR/RTL
заявляется только после независимой component matrix, а не по одному зелёному
build pipeline.
