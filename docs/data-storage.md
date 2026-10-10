# SQLite 数据存放说明

日报、成员、钉钉配置都在一个 SQLite 文件里。升级镜像或重建容器时，这个文件必须留在宿主机上，不能跟容器一起被换掉。

## 文件里有什么

库文件名固定为 `daily-report.db`。服务使用 WAL 模式，旁边可能还有两个同名附属文件，三个文件要一起备份、一起迁移：

| 文件 | 作用 |
| --- | --- |
| `daily-report.db` | 主库 |
| `daily-report.db-wal` | 尚未合并进主库的写入 |
| `daily-report.db-shm` | WAL 的共享内存索引 |

表：

| 表 | 内容 |
| --- | --- |
| `reports` | 每日工作内容、明日计划。主键是日期 + 成员 |
| `members` | 成员姓名、排序、钉钉手机号 |
| `config` | 钉钉 Webhook、加签密钥、检查时间、站点地址 |
| `cron_sent` | 某个工作日是否已经推送过未填写提醒 |

浏览器 `localStorage` 里还有一份前端缓存（键名 `team_daily_report_v1`、`team_daily_report_members_v1`）。那是当前浏览器的暂存，不是服务器上的历史库。换电脑、清站点数据后，缓存会没；服务器上的 `daily-report.db` 还在。

## 以前放在哪里

Docker 部署时，数据不在项目目录里，而在 Docker 命名卷中。

容器内路径：

```text
/data/daily-report.db
```

对应 `docker-compose.yml` 里原来的挂载：

```yaml
volumes:
  - daily-report-data:/data
```

Compose 会给卷名加上项目名前缀。项目目录叫 `daily-report`、又没有设置 `COMPOSE_PROJECT_NAME` 时，宿主机上的卷名是：

```text
daily-report_daily-report-data
```

Linux 上这个卷的实际目录一般是：

```text
/var/lib/docker/volumes/daily-report_daily-report-data/_data/daily-report.db
```

这是 Docker 管理的目录，不要当成普通项目文件去删。在服务器上可以用下面的命令确认卷是否还在：

```bash
docker volume ls | grep daily-report
docker volume inspect daily-report_daily-report-data
```

`inspect` 输出里的 `Mountpoint` 就是宿主机上的真实目录。

直接在项目里执行 `npm start`、且没有设置 `DATABASE_PATH` 时，不走 Docker 卷。文件在项目根目录：

```text
data/daily-report.db
```

这个目录已写入 `.gitignore`，不会进 Git。

## 现在放在哪里

容器内路径仍然是 `/data/daily-report.db`。变的是宿主机这边：`/data` 绑定到一个真实目录，不再只靠命名卷。

默认就是项目旁的 `./data`：

```text
<部署目录>/data/daily-report.db
```

`docker-compose.yml` 中的挂载：

```yaml
volumes:
  - ${DATA_DIR:-./data}:/data
  - daily-report-data:/var/lib/daily-report-legacy:ro
```

| 挂载 | 含义 |
| --- | --- |
| `${DATA_DIR:-./data}:/data` | 正在使用的库。升级镜像、`docker compose up -d`、`docker compose down` 都不会删除它 |
| `daily-report-data:/var/lib/daily-report-legacy:ro` | 只读挂上以前的命名卷，供第一次启动时拷贝。拷贝不会改旧卷 |

启动日志里会打印实际打开的文件，例如：

```text
[daily-report] sqlite /data/daily-report.db (kept on the host, not in the image)
```

这里的 `/data/...` 是容器内路径。对应到宿主机，就是 `DATA_DIR` 那个目录。

## 为什么要挪出来

命名卷在「同一目录里反复 `docker compose up -d --build`」时通常还在，但下面几种升级方式会让历史日报看起来像丢了：

- 换了一个发布目录。Compose 项目名变了，会新建一个空卷，旧卷还在 Docker 里，但新容器不再挂它。
- 执行了 `docker compose down -v` 或 `docker volume prune`。`-v` 会删掉命名卷。
- 不用 Compose、直接 `docker run` 新容器。镜像里的 `VOLUME /data` 会再分配一个匿名卷，旧容器的卷不会自动带上。

绑定到宿主机目录之后，数据库是普通文件。重建镜像、删除容器，都不会删这个目录。`docker compose down -v` 也只会删掉名为 `daily-report-data` 的旧卷，不会删 `DATA_DIR`。

## 升级时怎么迁移旧库

第一次用新配置启动时，`lib/db.js` 会做一次拷贝：

1. 若宿主机目标文件 `DATA_DIR/daily-report.db` 已经存在，什么都不覆盖。
2. 若目标文件不存在，且旧卷里有 `/var/lib/daily-report-legacy/daily-report.db`，则把主库以及 `-wal`、`-shm` 拷到 `DATA_DIR`。
3. 日志出现 `[daily-report] migrated sqlite to /data/daily-report.db` 表示拷贝已完成。
4. 之后每次启动都看到目标文件已存在，不再读旧卷。

旧卷一直只读挂着，作为这份拷贝的来源。确认新目录里的日报正常之后，可以再决定要不要留着旧卷。

生产环境不要把 `DATA_DIR` 放在「每次发布都会整目录删除」的路径里。在部署目录的 `.env` 里写成代码目录以外的绝对路径：

```bash
DATA_DIR=/var/lib/daily-report
```

这样即使发布目录整个换掉，历史日报仍在 `/var/lib/daily-report/daily-report.db`。`.env.example` 里有同样的说明。不设置 `DATA_DIR` 时，默认就是部署目录下的 `./data`。

## 推荐的升级步骤

在原来的部署目录执行，保证 Compose 还能找到原来的卷名：

```bash
# 1. 先看旧卷还在不在
docker volume ls | grep daily-report

# 2. 拉新代码 / 新镜像后，确认 .env 里的 DATA_DIR
#    生产建议：DATA_DIR=/var/lib/daily-report

# 3. 重建并启动。不要加 -v
docker compose up -d --build

# 4. 看是否完成迁移，以及现在打开的是哪个文件
docker compose logs --tail=50
```

然后在宿主机确认文件已经出现，例如：

```bash
ls -lh /var/lib/daily-report
# 或默认路径
ls -lh ./data
```

页面上能看到原来的日期和填写内容，即迁移成功。也可以看接口：

```bash
curl -s http://127.0.0.1:3000/api/stats
```

返回里的 `reportCount`、`dateCount` 应与升级前一致。

## 哪些操作是安全的

| 操作 | 历史数据 |
| --- | --- |
| `docker compose up -d --build` | 保留 |
| `docker compose restart` | 保留 |
| `docker compose down` 后再次 `up` | 保留。`down` 不加 `-v` 时，旧卷也还在 |
| 只更换镜像标签 | 保留 |
| `git pull` 后重启 | 保留。`data/` 被 Git 忽略，不会被代码覆盖 |
| `docker compose down -v` | `DATA_DIR` 里的新库还在；旧命名卷会被删除 |
| 删除 `DATA_DIR` 目录，或发布时把这个目录一起删掉 | 丢失 |
| 换目录部署，且新目录的 `DATA_DIR` 是空的，同时又找不到旧卷 | 会生成一套空库 |

## 手动从旧卷拷出来

如果自动迁移没发生（例如换了部署目录，Compose 没挂上原来的卷），可以手动拷。先找到卷：

```bash
docker volume ls
docker volume inspect <卷名>
```

用临时容器把卷里的文件拷到目标目录。下面假设卷名是 `daily-report_daily-report-data`，目标是 `/var/lib/daily-report`。目标里还没有 `daily-report.db` 时再执行：

```bash
mkdir -p /var/lib/daily-report
docker run --rm \
  -v daily-report_daily-report-data:/from:ro \
  -v /var/lib/daily-report:/to \
  node:24-bookworm-slim \
  sh -c 'cp -a /from/daily-report.db /to/ && \
         [ -f /from/daily-report.db-wal ] && cp -a /from/daily-report.db-wal /to/ || true && \
         [ -f /from/daily-report.db-shm ] && cp -a /from/daily-report.db-shm /to/ || true'
```

然后把 `.env` 设为 `DATA_DIR=/var/lib/daily-report`，再 `docker compose up -d`。因为目标文件已经存在，启动时不会用空库覆盖它。

## 备份

停写或直接热拷都可以，更稳妥的是连同 WAL 一起拷：

```bash
mkdir -p /var/backups/daily-report
cp -a /var/lib/daily-report/daily-report.db /var/backups/daily-report/daily-report-$(date +%F).db
cp -a /var/lib/daily-report/daily-report.db-wal /var/backups/daily-report/ 2>/dev/null || true
cp -a /var/lib/daily-report/daily-report.db-shm /var/backups/daily-report/ 2>/dev/null || true
```

恢复时把这三个文件放回 `DATA_DIR`，再重启容器。恢复前先停容器，避免写到一半被盖掉。
