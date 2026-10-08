# 团队日报系统 · 阿里云部署文档

本文档介绍如何把项目完整部署到阿里云 ECS 服务器,实现国内免 VPN 直接访问,数据存到本地 SQLite 文件(永久持久化)。

## 一、整体架构

```
阿里云 ECS (Ubuntu 22.04)
├── Nginx 80/443              反向代理 + 静态文件 + SSL
├── Node.js 应用 (index.js)   监听 127.0.0.1:3000
├── PM2                       守护进程,崩溃自动重启
└── SQLite 数据文件           /var/lib/daily-report/data.db
```

- 前端 → Nginx 直接返回静态文件
- API → Nginx 反代到 Node.js 后端
- 数据 → 本地 SQLite 文件,永久持久化
- HTTPS → Nginx 配置 SSL 证书(阿里云免费证书或 Let's Encrypt)
- 定时任务 → crontab,工作日 21:30 检查未填写日报并推送钉钉

## 二、前置准备

### 1. 购买阿里云 ECS

- **实例规格**:1 核 2G 起步(t6 / 突发性能型即可),日报系统流量不大
- **操作系统**:Ubuntu 22.04 LTS(本文档以此为例)
- **公网带宽**:1~5 Mbps 按量付费或包月
- **地域**:就近选华东 1(杭州)/ 华北 2(北京),国内访问最快

### 2. 域名 + ICP 备案(强烈推荐)

阿里云买 ECS 后可顺便买域名:
- 阿里云万网 https://wanwang.aliyun.com
- `.cn` / `.com` 几十元/年
- **国内服务器必须 ICP 备案**才能 80/443 端口对外提供服务
- 备案流程 https://beian.aliyun.com,约 7~20 个工作日

备案期间可以先用 `http://公网IP:3000` 临时访问,备案通过后再切换域名 + HTTPS。

### 3. 安全组放行端口

阿里云控制台 → ECS → 安全组 → 配置规则,放行:

| 端口 | 用途 |
|---|---|
| 22 | SSH 登录 |
| 80 | HTTP |
| 443 | HTTPS |
| 3000 | Node.js 直连(临时调试用,备案后可关闭) |

## 三、服务器初始化

### 1. SSH 登录服务器

```bash
ssh root@你的公网IP
```

### 2. 创建非 root 用户(推荐)

```bash
adduser daily
usermod -aG sudo daily
su - daily
```

后续操作都用 daily 用户执行。

### 3. 更新系统 + 安装基础依赖

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl build-essential nginx
```

### 4. 安装 Node.js 20 LTS(用 NodeSource 仓库)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # 应输出 v20.x.x
npm -v    # 应输出 10.x.x
```

### 5. 安装 PM2(进程守护)

```bash
sudo npm install -g pm2
pm2 -v    # 应输出版本号
```

## 四、部署项目代码

### 1. 创建项目目录

```bash
sudo mkdir -p /var/lib/daily-report
sudo chown daily:daily /var/lib/daily-report
cd /var/lib/daily-report
```

### 2. 上传项目文件(三选一)

#### 方式 A:从 GitHub 拉取(推荐)

```bash
git clone https://github.com/alterman007/daily-report.git .
```

#### 方式 B:用 scp 上传(本地执行)

本地终端:
```bash
scp -r /workspace/* root@你的公网IP:/var/lib/daily-report/
```

#### 方式 C:用 zip 包上传

本地把项目打包:
```bash
cd /workspace
zip -r daily-report.zip . -x "node_modules/*" ".git/*"
scp daily-report.zip root@你的公网IP:~
```

服务器解压:
```bash
mkdir -p /var/lib/daily-report
sudo chown daily:daily /var/lib/daily-report
unzip ~/daily-report.zip -d /var/lib/daily-report
```

### 3. 安装项目依赖

```bash
cd /var/lib/daily-report
npm install --omit=dev
```

### 4. 验证项目能跑

```bash
# 临时启动测试
node index.js
# 看到类似 "[index.js] listening on 3000" 表示成功
# Ctrl+C 停止
```

## 五、配置 SQLite 数据持久化

### 1. 创建数据目录

```bash
sudo mkdir -p /var/lib/daily-report/data
sudo chown daily:daily /var/lib/daily-report/data
```

### 2. 设置环境变量

创建环境变量文件:

```bash
cat > /var/lib/daily-report/.env <<'EOF'
# SQLite 数据库文件路径(本地文件)
LIBSQL_URL=file:/var/lib/daily-report/data/daily-report.db

# 钉钉 Cron 鉴权(可选,防止外部触发)
CRON_SECRET=替换成一段随机字符串

# 应用端口
PORT=3000

# 节点环境
NODE_ENV=production
EOF
chmod 600 /var/lib/daily-report/.env
```

### 3. 让 PM2 自动加载 .env

后续 PM2 配置会用到 ecosystem 文件,里面会引用这些环境变量。

## 六、用 PM2 启动并守护进程

### 1. 创建 PM2 配置文件

```bash
cat > /var/lib/daily-report/ecosystem.config.js <<'EOF'
module.exports = {
  apps: [{
    name: 'daily-report',
    script: 'index.js',
    cwd: '/var/lib/daily-report',
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      LIBSQL_URL: 'file:/var/lib/daily-report/data/daily-report.db'
    }
  }]
};
EOF
```

### 2. 启动应用

```bash
cd /var/lib/daily-report
pm2 start ecosystem.config.js
pm2 status
```

应看到 `daily-report` 状态为 `online`。

### 3. 验证启动成功

```bash
curl http://127.0.0.1:3000/api/stats
```

应返回类似:
```json
{"ok":true,"storage":"SQLite (Turso libSQL)","databaseUrl":"file:/var/lib/daily-report/data/daily-report.db",...}
```

### 4. 设置 PM2 开机自启

```bash
pm2 save
pm2 startup
# 按提示执行输出的命令,例如:sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u daily --hp /home/daily
```

### 5. 常用 PM2 命令

```bash
pm2 status              # 查看状态
pm2 logs daily-report   # 实时日志
pm2 restart daily-report  # 重启
pm2 stop daily-report    # 停止
pm2 delete daily-report # 删除
```

## 七、配置 Nginx 反向代理

### 1. 创建 Nginx 配置文件

```bash
sudo tee /etc/nginx/sites-available/daily-report <<'EOF'
# 团队日报系统
server {
    listen 80;
    server_name _;  # 备案后改成你的域名

    # 静态文件直接由 Nginx 提供
    root /var/lib/daily-report;
    index index.html;

    # 上传/请求体大小
    client_max_body_size 10M;

    # API 反代到 Node.js
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # 钉钉 webhook 接口可能慢,延长超时
        proxy_read_timeout 30s;
        proxy_connect_timeout 10s;
    }

    # 静态文件(根路径返回 index.html)
    location / {
        try_files $uri $uri/ /index.html;
    }

    # 静态资源缓存
    location ~* \.(js|css|png|jpg|svg|ico)$ {
        expires 7d;
        add_header Cache-Control "public, no-transform";
    }
}
EOF
```

### 2. 启用站点

```bash
sudo ln -sf /etc/nginx/sites-available/daily-report /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t       # 测试配置
sudo systemctl reload nginx
```

### 3. 验证 HTTP 访问

浏览器打开:
```
http://你的公网IP/
```

应看到日报页面。再访问:
```
http://你的公网IP/api/stats
```

应返回 JSON 统计信息。

## 八、配置 HTTPS(域名备案后)

### 方式 1:阿里云免费 SSL 证书(推荐,简单)

1. 阿里云控制台 → **数字证书管理服务** → **SSL 证书** → **免费证书**
2. 申请免费证书(每年 20 个免费额度),绑定你的域名
3. 下载证书,选 Nginx 格式,得到:
   - `你的域名.pem`
   - `你的域名.key`
4. 上传到服务器:
   ```bash
   sudo mkdir -p /etc/nginx/ssl
   # 把 .pem 和 .key 上传到这个目录
   sudo chmod 644 /etc/nginx/ssl/*.pem
   sudo chmod 600 /etc/nginx/ssl/*.key
   ```

5. 修改 Nginx 配置:

```bash
sudo tee /etc/nginx/sites-available/daily-report <<'EOF'
# HTTP 跳 HTTPS
server {
    listen 80;
    server_name 你的域名;
    return 301 https://$host$request_uri;
}

# HTTPS
server {
    listen 443 ssl;
    server_name 你的域名;

    ssl_certificate     /etc/nginx/ssl/你的域名.pem;
    ssl_certificate_key /etc/nginx/ssl/你的域名.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    root /var/lib/daily-report;
    index index.html;

    client_max_body_size 10M;

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \.(js|css|png|jpg|svg|ico)$ {
        expires 7d;
        add_header Cache-Control "public, no-transform";
    }
}
EOF

sudo nginx -t && sudo systemctl reload nginx
```

### 方式 2:Let's Encrypt(免费自动续期)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 你的域名 -d www.你的域名
# 按提示同意协议,自动配置 SSL
```

证书 90 天到期,设置自动续期:
```bash
sudo crontab -e
# 添加一行:
0 3 1 * * certbot renew --quiet
```

## 九、配置定时任务(钉钉自动提醒)

### 1. 编辑 crontab

```bash
crontab -e
```

### 2. 添加定时任务

工作日(周一~周五)每天 21:30 触发(北京时间):

```cron
# 团队日报 - 每工作日 21:30 检查未填写并推送钉钉
30 21 * * 1-5 /usr/bin/curl -s http://127.0.0.1:3000/api/cron > /dev/null 2>&1
```

保存退出后,crontab 会立即生效。

### 3. 验证定时任务

```bash
crontab -l
```

应能看到刚添加的任务。

### 4. 手动测试 Cron 接口

```bash
curl http://127.0.0.1:3000/api/cron
```

应返回类似:
```json
{"ok":true,"skipped":false,"now":{"date":"2026-10-08","hour":16,"minute":59,"weekday":"Thu"},...}
```

## 十、数据备份

### 1. 手动备份

```bash
# 备份 SQLite 数据库
cp /var/lib/daily-report/data/daily-report.db ~/daily-report-backup-$(date +%Y%m%d).db
```

### 2. 自动每日备份

```bash
crontab -e
# 添加:
0 2 * * * cp /var/lib/daily-report/data/daily-report.db /home/daily/backup/daily-report-$(date +\%Y\%m\%d).db && find /home/daily/backup -mtime +30 -delete
```

每天凌晨 2 点备份,保留 30 天。

## 十一、常见问题排查

### 1. 访问 502 Bad Gateway

Node.js 没启动或崩了:

```bash
pm2 status              # 看 daily-report 是否 online
pm2 logs daily-report   # 看错误日志
pm2 restart daily-report
```

### 2. 数据库写入失败

检查 SQLite 文件权限:

```bash
ls -la /var/lib/daily-report/data/
# daily 用户必须有读写权限
sudo chown -R daily:daily /var/lib/daily-report/data
```

### 3. 钉钉推送失败

- 检查日报页面里钉钉 webhook 是否配置正确
- 手动测试:
  ```bash
  curl -X POST http://127.0.0.1:3000/api/notify?date=2026-10-08
  ```
- 查看日志:
  ```bash
  pm2 logs daily-report --lines 100
  ```

### 4. 端口被占用

```bash
sudo lsof -i:3000
# 看到 PID 后 sudo kill -9 PID
pm2 restart daily-report
```

### 5. 修改代码后部署

```bash
cd /var/lib/daily-report
git pull origin master       # 拉新代码
npm install --omit=dev       # 如有新依赖
pm2 restart daily-report
```

## 十二、防火墙建议(可选)

开启 UFW 只放行必要端口:

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

## 十三、目录结构总览

部署完成后,服务器目录结构:

```
/var/lib/daily-report/
├── api/                    # API 函数
│   ├── _lib.js
│   ├── config.js
│   ├── cron.js
│   ├── day.js
│   ├── members.js
│   ├── notify.js
│   ├── save-day.js
│   ├── stats.js
│   └── test.js
├── public/
│   └── index.html          # 前端页面
├── data/
│   └── daily-report.db     # SQLite 数据库(永久持久化)
├── index.js                # Node 入口
├── package.json
├── package-lock.json
├── ecosystem.config.js     # PM2 配置
├── .env                    # 环境变量
├── local-dev.js            # 本地开发用,生产不需要
└── vercel.json             # Vercel 用,阿里云可忽略
```

## 十四、访问验证清单

部署完成后,依次访问以下 URL 验证:

| URL | 预期结果 |
|---|---|
| `http://公网IP/` | 日报录入页面 |
| `http://公网IP/api/stats` | JSON 统计信息 |
| `http://公网IP/api/members` | JSON 数组,成员列表 |
| `http://公网IP/api/day?date=2026-10-08` | JSON 对象,当日日报 |

在前端页面:
- 添加成员 → 保存 → 刷新 `/api/stats` 看 memberCount 增加
- 填写日报 → 保存 → toast 显示 "✅ 已保存到云端 SQLite"
- 配置钉钉 webhook → 保存 → 保存测试

## 十五、续费与维护

- **ECS 按月/年续费**:阿里云控制台 → ECS → 续费管理
- **域名续费**:阿里云控制台 → 域名 → 续费
- **SSL 证书续期**:阿里云免费证书每年需重新申请,或用 Let's Encrypt 自动续期
- **数据迁移**:把 `data/daily-report.db` 文件复制走即可

---

至此,整个团队日报系统已部署到阿里云,国内免 VPN 直接访问,数据永久存储到本地 SQLite 文件,每日 21:30 自动检查未填写日报并推送钉钉群。
