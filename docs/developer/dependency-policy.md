# Runtime и dependency policy

## Принятый runtime

Node `20.19.5`, Yarn `1.22.22`, Webpack `5.108.4` и committed `yarn.lock`
образуют accepted compatibility runtime. Install всегда выполняется с
`--frozen-lockfile --ignore-scripts`.

Webpack уже находится на актуальной 5-й линии. Остальные output-producing
dependencies нельзя поднимать только по номеру версии: они являются частью
формата generated distribution.

## Почему lockfile намеренно сохранён

Пробное обновление Sass/PostCSS/Babel/loaders до текущих major-линий обнаружило
два несовместимых изменения:

1. новый `postcss-preset-env` физически преобразовал logical declarations,
   нарушив обязательное retention/fallback-order правило;
2. новый loader graph создавал повторяющиеся Webpack runtime identifiers и
   ломал deterministic product build до материализации output.

Поэтому repository/CI/Node contract обновлён, а accepted output toolchain
оставлен frozen. Это compatibility pin, а не забытое обновление.

## Правило обновления

Dependency update принимается только отдельным кандидатом:

1. обновить lockfile в отдельной ветке;
2. пройти `yarn run verify`;
3. выполнить две frozen product-волны на exact `ui-loader`;
4. классифицировать каждый generated-output diff;
5. передать exact SHA/tree независимому тестировщику;
6. только после PASS готовить generated distribution rebind.

Нельзя одновременно обновлять toolchain и молча публиковать `ui`/`ui-smart`.
