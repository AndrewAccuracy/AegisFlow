# AegisFlow 本地 Docker 靶场

`docker/local-goad-topology/` 是 AegisFlow 配套的本地 Docker 靶场。它用 Linux 容器模拟一个小型企业内网，不运行 GOAD/Windows AD，而是保留“外部入口 -> DMZ -> 跳板 -> 办公网 -> 核心服务区”的攻击路径形状，方便在本机做授权演示、课堂实验、Dashboard 回放和 agent 调度测试。

> 这个环境只用于本地、授权、可控的安全实验。不要把这里的目标、凭据、payload 或流程用于任何未授权系统。

## 目录

- [整体拓扑](#整体拓扑)
- [网络分区](#网络分区)
- [靶机分布](#靶机分布)
- [路由与访问关系](#路由与访问关系)
- [启动靶场](#启动靶场)
- [宿主机访问入口](#宿主机访问入口)
- [进入内网](#进入内网)
- [DNS 与域名](#dns-与域名)
- [账号与实验凭据](#账号与实验凭据)
- [Flag 分布](#flag-分布)
- [漏洞与攻击路径](#漏洞与攻击路径)
- [和 AegisFlow 联动](#和-aegisflow-联动)
- [验证环境](#验证环境)
- [停止与清理](#停止与清理)
- [常见问题](#常见问题)

## 整体拓扑

当前只维护这一张静态靶场拓扑图：

![Docker Linux enterprise lab topology](assets/topology.png)

Dashboard 里的“拓扑”页面是 agent 运行时根据发现生成的资产关系图，不是第二套靶场拓扑。

## 网络分区

| 区域 | Docker network | CIDR | 网关 / 路由节点 | 作用 |
| --- | --- | --- | --- | --- |
| DMZ | `dmz` | `10.80.10.0/24` | `jump01` 的 `10.80.10.20` | 对宿主机暴露入口服务，模拟公网边界。 |
| Office / Ops | `office` | `10.80.20.0/24` | `jump01` 的 `10.80.20.254` | 内部办公、研发、邮件和 Web 应用服务。 |
| Core Services | `core` | `10.80.30.0/24` | `jump01` 的 `10.80.30.254` | 身份、数据库、缓存、文件、对象存储和 DNS。 |

默认只有两个端口发布到宿主机：

| 宿主机地址 | 容器目标 | 用途 |
| --- | --- | --- |
| `http://127.0.0.1:18080/` | `thinkphp:80` | DMZ Web 入口。 |
| `ssh://127.0.0.1:2222` | `jump01:22` | SSH 跳板入口。 |

其余服务默认只在 Docker 内部网络可达，需要从 `thinkphp`、`jump01`、`dev01` 或 SSH 隧道访问。

## 靶机分布

| 节点 | 容器名 | IP | 区域 | 主要端口 | 角色 |
| --- | --- | --- | --- | --- | --- |
| `thinkphp` | `lab-thinkphp` | `10.80.10.10` | DMZ | `80/tcp` | ThinkPHP 5.0.12 入口站点，宿主机映射到 `18080`。 |
| `jump01` | `lab-jump01` | `10.80.10.20`, `10.80.20.254`, `10.80.30.254` | DMZ / Office / Core | `22/tcp` | 三网卡 Linux 路由器和 SSH 跳板，宿主机映射到 `2222`。 |
| `intranet` | `lab-intranet` | `10.80.20.10` | Office | `80/tcp` | 内网 Nginx 门户，列出关键内部服务。 |
| `wiki01` | `lab-wiki01` | `10.80.20.11` | Office | `8080/tcp` | Apache Struts 2.3.30 漏洞靶机。 |
| `git01` | `lab-git01` | `10.80.20.20` | Office | `3000/tcp`, `22/tcp` | Gogs 0.11.66 代码托管靶机。 |
| `mail01` | `lab-mail01` | `10.80.20.30` | Office | `1025/tcp`, `8025/tcp` | Mailpit SMTP 和 Web 邮箱。 |
| `dev01` | `lab-dev01` | `10.80.20.50` | Office | `22/tcp` | 内部 Linux 工作站，预装常用探测和客户端工具。 |
| `ldap01` | `lab-ldap01` | `10.80.30.10` | Core | `389/tcp`, `636/tcp` | OpenLDAP 目录服务。 |
| `db01` | `lab-db01` | `10.80.30.20` | Core | `3306/tcp` | MariaDB，内置 `app_prod` 示例数据。 |
| `cache01` | `lab-cache01` | `10.80.30.30` | Core | `6379/tcp` | Redis 5.0.7 漏洞靶机。 |
| `files01` | `lab-files01` | `10.80.30.40` | Core | `445/tcp`, `139/tcp` | Samba 4.6.3 文件共享靶机。 |
| `minio01` | `lab-minio01` | `10.80.30.50` | Core | `9000/tcp`, `9001/tcp` | S3 兼容对象存储和管理控制台。 |
| `dns01` | `lab-dns01` | `10.80.30.53` | Core | `53/tcp`, `53/udp` | CoreDNS，提供 `corp.local` 区域解析。 |

## 路由与访问关系

`jump01` 开启 IPv4 forwarding，并在 `dmz`、`office`、`core` 三个 Docker 网络之间转发流量。

关键路由如下：

| 来源 | 路由 |
| --- | --- |
| `thinkphp` | `10.80.20.0/24 via 10.80.10.20` |
| `thinkphp` | `10.80.30.0/24 via 10.80.10.20` |
| `dev01` | `10.80.30.0/24 via 10.80.20.254` |

这意味着：

- 宿主机可以直接访问 DMZ 入口 `127.0.0.1:18080`。
- `thinkphp` 可以通过 `jump01` 路由访问 Office 和 Core。
- `dev01` 可以访问 Core 服务区，适合作为后渗透工作站。
- 宿主机不能直接访问 Office/Core 的容器 IP，推荐使用 `jump01` SSH 隧道或 `docker exec` 进入内网。

## 启动靶场

### macOS / Linux

```bash
cd docker/local-goad-topology
docker compose up -d --build
```

### Windows PowerShell

普通 Docker Desktop 环境通常只需要：

```powershell
cd .\docker\local-goad-topology
docker compose up -d --build
```

如果你的 Docker Desktop 需要指定命名管道，可以显式设置：

```powershell
$env:DOCKER_HOST='npipe:////./pipe/dockerDesktopLinuxEngine'
cd .\docker\local-goad-topology
docker compose up -d --build
```

如果你使用独立的 Docker 配置目录，再额外设置 `DOCKER_CONFIG`：

```powershell
$env:DOCKER_CONFIG='C:\path\to\.docker'
$env:DOCKER_HOST='npipe:////./pipe/dockerDesktopLinuxEngine'
cd .\docker\local-goad-topology
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
```

## 宿主机访问入口

DMZ ThinkPHP 入口：

```text
http://127.0.0.1:18080/
```

SSH 跳板：

```bash
ssh jumpop@127.0.0.1 -p 2222
```

密码：

```text
JumpPass123!
```

## 进入内网

### 方式一：进入 dev01 工作站

```bash
cd docker/local-goad-topology
docker exec -it lab-dev01 sh
```

`dev01` 预装了常用工具，包括：

```text
bind-tools, curl, git, iproute2, jq, mariadb-client, netcat-openbsd,
nmap, openldap-clients, openssh, postgresql-client, redis, samba-client,
vim, wget
```

常用检查命令：

```sh
nmap -sT 10.80.20.0/24
nmap -sT 10.80.30.0/24
curl http://10.80.20.10
curl http://10.80.20.11:8080
curl http://10.80.20.20:3000
mariadb -h 10.80.30.20 -uapp_svc -pAppSvcPass123! app_prod
redis-cli -h 10.80.30.30 ping
smbclient -L //10.80.30.40 -N -m SMB3
ldapsearch -x -H ldap://10.80.30.10 -D 'cn=admin,dc=corp,dc=local' -w 'AdminPassw0rd!' -b 'dc=corp,dc=local' -s base dn
```

### 方式二：通过 jump01 建立 SSH 隧道

```bash
ssh -N \
  -L 18081:10.80.20.10:80 \
  -L 18082:10.80.20.11:8080 \
  -L 13000:10.80.20.20:3000 \
  -L 18025:10.80.20.30:8025 \
  -L 19001:10.80.30.50:9001 \
  jumpop@127.0.0.1 -p 2222
```

Windows PowerShell 续行写法：

```powershell
ssh -N `
  -L 18081:10.80.20.10:80 `
  -L 18082:10.80.20.11:8080 `
  -L 13000:10.80.20.20:3000 `
  -L 18025:10.80.20.30:8025 `
  -L 19001:10.80.30.50:9001 `
  jumpop@127.0.0.1 -p 2222
```

隧道建立后，在宿主机打开：

| 本地地址 | 内部服务 |
| --- | --- |
| `http://127.0.0.1:18081` | `intranet` |
| `http://127.0.0.1:18082` | `wiki01` Struts |
| `http://127.0.0.1:13000` | `git01` Gogs |
| `http://127.0.0.1:18025` | `mail01` Mailpit |
| `http://127.0.0.1:19001` | `minio01` MinIO Console |

## DNS 与域名

`dns01` 提供 `corp.local` 区域解析：

| 域名 | IP |
| --- | --- |
| `thinkphp.corp.local` | `10.80.10.10` |
| `jump01.corp.local` | `10.80.10.20` |
| `intranet.corp.local` | `10.80.20.10` |
| `wiki01.corp.local` | `10.80.20.11` |
| `git01.corp.local` | `10.80.20.20` |
| `mail01.corp.local` | `10.80.20.30` |
| `dev01.corp.local` | `10.80.20.50` |
| `ldap01.corp.local` | `10.80.30.10` |
| `db01.corp.local` | `10.80.30.20` |
| `cache01.corp.local` | `10.80.30.30` |
| `files01.corp.local` | `10.80.30.40` |
| `minio01.corp.local` | `10.80.30.50` |
| `dns01.corp.local` | `10.80.30.53` |

查询示例：

```sh
dig +short @10.80.30.53 db01.corp.local
```

## 账号与实验凭据

这些是本地靶场用的合成凭据，不是生产 secret。

| 服务 | 用户名 / DN | 密码 |
| --- | --- | --- |
| `jump01` SSH | `jumpop` | `JumpPass123!` |
| `dev01` SSH | `analyst` | `Analyst123!` |
| `git01` SSH root | `root` | `GitRootPass123!` |
| MariaDB root | `root` | `RootPassw0rd!` |
| MariaDB app | `app_svc` | `AppSvcPass123!` |
| OpenLDAP admin DN | `cn=admin,dc=corp,dc=local` | `AdminPassw0rd!` |
| MinIO root | `minioadmin` | `MinioAdmin123!` |
| Redis | 无用户名 | 无密码 |
| Samba `myshare` | guest | 无密码 |

## Flag 分布

每个 flag 都是本地实验数据，挂载自 `docker/local-goad-topology/flags/`。

| 节点 | 容器内位置 / 访问方式 |
| --- | --- |
| `thinkphp` | `/flag.txt` |
| `wiki01` | `/flag.txt` |
| `git01` | `/flag.txt`，同时通过 `http://10.80.20.20:3000/flag.txt` 暴露 |
| `cache01` | `/flag.txt` |
| `files01` | `/flag.txt`，同时通过 `//10.80.30.40/myshare/flag.txt` 暴露 |
| `minio01` | `s3://flag/flag.txt`，初始化容器会设置匿名下载 |

快速验证：

```sh
curl http://10.80.20.20:3000/flag.txt
smbclient //10.80.30.40/myshare -N -m SMB3 -c 'get flag.txt -'
```

## 漏洞与攻击路径

漏洞索引见 [VULNERABILITIES.md](VULNERABILITIES.md)。

当前设计的主要攻击路径：

```text
ThinkPHP 入口 -> Office 漏洞应用 -> 凭据 / 代码 / 邮件线索 -> Core 漏洞服务 -> 数据目标 / flag
```

重点靶机：

| 节点 | 组件 | 参考 |
| --- | --- | --- |
| `thinkphp` | ThinkPHP `5.0.12` 请求路由 / 方法调用攻击面 | ThinkPHP 5.0.x lab entry |
| `wiki01` | Apache Struts `2.3.30`, S2-045 | `CVE-2017-5638` |
| `git01` | Gogs `0.11.66` | `CVE-2018-18925` |
| `cache01` | Redis `5.0.7` Vulhub lab | `CVE-2022-0543` |
| `files01` | Samba `4.6.3` guest writable share | `CVE-2017-7494` |

辅助目标：

| 节点 | 用途 |
| --- | --- |
| `intranet` | 内部服务导航和信息泄露入口。 |
| `mail01` | 邮件线索、通知和测试 SMTP。 |
| `dev01` | 横向移动后的工作站。 |
| `ldap01` | 账号、组织和目录枚举。 |
| `db01` | 业务数据目标。 |
| `minio01` | 备份、导出文件和对象存储目标。 |
| `dns01` | 内部域名解析。 |

## 和 AegisFlow 联动

启动靶场后，回到项目根目录，把 agent 的初始目标设成宿主机发布的 DMZ 入口：

```bash
cd ../..
node src/index.js \
  -t 127.0.0.1 \
  -p 18080 \
  --flags 6 \
  --min-loops 1 \
  --max-loops 12 \
  --stop-after-stale 3
```

如果从 Dashboard 启动：

| 字段 | 建议值 |
| --- | --- |
| Target host | `127.0.0.1` |
| Target port | `18080` |
| Scope | `entry-port` 起步；确认授权后可按需允许私网横向 |
| Expected flags | `6` |
| Max loops | `8` 到 `12` |

建议演示顺序：

1. 先打开 `http://127.0.0.1:18080/`，确认 DMZ 入口可访问。
2. 在 Dashboard 启动任务，让 agent 从入口页面枚举内部服务。
3. 观察拓扑页中 DMZ、Office、Core 节点逐步出现。
4. 通过 Flags 页核对发现来源和证据。
5. 需要人工验证时，进入 `lab-dev01` 或使用 `jump01` 隧道复查。

## 验证环境

### 基础验证

```bash
cd docker/local-goad-topology
docker compose ps
curl -fsS http://127.0.0.1:18080/ >/dev/null
docker exec lab-thinkphp ip route
docker exec lab-thinkphp sh -c 'nc -vz -w 5 10.80.20.10 80'
docker exec lab-thinkphp sh -c 'dig +short @10.80.30.53 db01.corp.local'
```

### 脚本验证

Windows PowerShell:

```powershell
cd .\docker\local-goad-topology
.\scripts\test.ps1
```

`scripts/test.ps1` 会检查：

- Compose 服务状态。
- ThinkPHP 入口 HTTP。
- `thinkphp` 到 Office/Core 的路由。
- 从 DMZ 入口到各内网端口的可达性。
- CoreDNS 解析。
- 从 `dev01` 访问 MariaDB、Struts、Gogs、Redis、LDAP、Samba 和 MinIO。

如果你不是原始 Windows 路径环境，请按需删除或修改脚本顶部的 `DOCKER_CONFIG` / `DOCKER_HOST` 设置。

## 停止与清理

停止容器但保留卷：

```bash
cd docker/local-goad-topology
docker compose down
```

停止并删除数据库、MinIO 等持久化卷：

```bash
cd docker/local-goad-topology
docker compose down -v
```

重新构建：

```bash
docker compose build --no-cache
docker compose up -d
```

## 常见问题

### 访问 `127.0.0.1:18080` 失败

先看容器状态和端口映射：

```bash
docker compose ps
docker logs lab-thinkphp --tail 80
```

确认没有其它进程占用 `18080`。如需改端口，修改 `docker-compose.yml` 中 `thinkphp` 的 `ports` 映射。

### SSH 到 `127.0.0.1:2222` 失败

检查跳板容器：

```bash
docker logs lab-jump01 --tail 80
docker exec lab-jump01 ip addr
```

确认使用的是：

```text
jumpop / JumpPass123!
```

### 内网服务从宿主机打不开

这是预期行为。Office/Core 没有直接发布到宿主机。使用 `docker exec -it lab-dev01 sh` 进入内网，或者通过 `jump01` 建 SSH 隧道。

### `dev01` 访问 Core 失败

检查路由：

```bash
docker exec lab-dev01 ip route
docker exec lab-dev01 sh -c 'nc -vz -w 5 10.80.30.20 3306'
```

正常情况下应该看到：

```text
10.80.30.0/24 via 10.80.20.254
```

### MinIO flag 不存在

等待初始化容器完成：

```bash
docker logs lab-minio-init
```

如果需要重置 MinIO 数据：

```bash
docker compose down -v
docker compose up -d --build
```
