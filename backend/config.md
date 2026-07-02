# 数据库配置说明

`db_type` 支持三种值：

| db_type | 引擎 | 环境变量 |
|---------|------|---------|
| `sqlite` | SQLite3 | 无需额外配置 |
| `postgresql` | PostgreSQL | `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_HOST`, `POSTGRES_PORT` |
| `mysql` | MySQL | `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT` |

## MySQL 示例配置

{
  "db_type": "mysql",
  "db_config": {
    "host": "localhost",
    "port": 3306,
    "name": "pretty-chick",
    "user": "root",
    "password": "your_password"
  }
}

环境变量 `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE` 会覆盖 `db_config` 中的对应字段。
