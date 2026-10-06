# WordWise

<!-- wordwise-readme-language:begin -->
<p align="right">
  <a href="README.zh-CN.md"><strong>中文</strong></a> | <a href="README.fr.md">Français</a> | <a href="README.md">English</a>
</p>
<!-- wordwise-readme-language:end -->

WordWise 是一款桌面英语词汇学习应用，帮助你专注练习并巩固长期记忆。
你可以建立个人词表，按自己的节奏学习，复习错题，并查看容易混淆的单词。

**我们现已公开应用的部分核心算法。**

桌面应用以本地运行为主，学习记录保存在设备上。你也可以使用本地语言模型，
为输入的答案提供语义反馈。

<!-- wordwise-web-v2:begin -->
## WordWise Web v2.0 — 公开测试版

**[打开 WordWise Web](https://wordwise.dpdns.org/)**，注册新账户或使用已有账户登录。
在线平台现为 v2.0；下方的桌面版下载仍为 v1.0。本仓库公开部分桌面应用源码和
核心算法，并不包含在线服务的完整源码。

- 学习英语词汇，并用中文或法语回答单词的含义。
- 可选择法语、中文或英语界面。首次访问时会根据浏览器语言选择界面：法语浏览器
  使用法语，中文浏览器使用中文，其他语言使用英语。之后优先使用你已保存的选择。
- 在 **设置与词表 → 语言** 中修改界面语言。登录前也有一个简洁的语言选择控件。
  界面语言会设置默认学习模式；你也可以在侧栏单独选择学习模式。
- 法语学习提供 **TOEFL、IELTS、Tous les mots** 和个人词表 **Mes mots**，
  并支持自适应练习、错题复习、易混词图、提示，以及词汇导入和导出。

<!-- wordwise-web-v2:end -->

## 主要功能

- 随机、顺序和自适应练习模式
- 间隔复习和错题专项练习
- 展示反复混淆情况的个人易混词图
- 个人词表的导入和导出
- 支持 macOS 和 Windows 桌面应用打包

## 快速开始

```bash
npm install
npm test
npm start
```

如果没有适用的预编译模块，可以使用 Rust 在本地重新构建原生词汇引擎：

```bash
npm run build --prefix vocab-core
```

公开源码快照不包含本地模型权重、内置词表、音频归档、付费分发素材、私人研究资料、
仅供运营人员使用的许可证工具或发行安装包。添加词汇或模型文件时，请使用你有权
再分发的来源。

<!-- wordwise-public-tools:begin -->
## 公开开发工具

源码包含音频打包、词汇数据库预生成和桌面应用打包工具。另有两个只读检查命令，
分别检查**暂存区中的公开文件白名单**和 **macOS/Windows 安装包的文件选择**：

```bash
npm run check:public-files
npm run check:package-files
```

<!-- wordwise-public-tools:end -->

## 下载

### 在线体验版现已开放：[WordWise-Web](https://wordwise.dpdns.org)

- 百度网盘：[WordWise-v1.0.0](https://pan.baidu.com/s/1LD4QVatnQr7FSxPloC1c5A)，提取码：vjra
- Google Drive：[WordWise-v1.0.0](https://drive.google.com/drive/folders/1jb0jFgo42EUx7rVZQSWyhnYVrrr3LOGF?usp=sharing)

**如有任何问题，或希望申请一年的免费试用，请联系开发者：feedback@wordwise.dpdns.org。**

## 许可证

WordWise 采用 MIT 许可证发布。详见 [`LICENSE`](LICENSE)。
