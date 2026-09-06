@echo off
setlocal
title BBPlayer 开发测试启动器

REM ============================================================
REM  BBPlayer 开发测试启动器
REM  用途：无需打包 EXE，直接以源码方式启动软件进行测试。
REM  用法：
REM    1. 双击 run-test.bat 直接启动软件
REM    2. 把一个或多个视频文件拖到 run-test.bat 图标上，
REM       启动后会自动播放这些视频
REM ============================================================

cd /d "%~dp0"

echo ============================================================
echo    BBPlayer - 开发测试启动器
echo ============================================================
echo.

REM ---------- 第 1 步：检查 Node.js ----------
echo [1/4] 检查 Node.js 环境...
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   [错误] 未检测到 Node.js！
    echo   请先安装 Node.js 后重试：https://nodejs.org/
    echo.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node -v') do set "NODE_VER=%%v"
echo   [通过] Node.js 版本：%NODE_VER%
echo.

REM ---------- 第 2 步：检查 Electron 依赖 ----------
echo [2/4] 检查 Electron 依赖...
if not exist "node_modules\electron\dist\electron.exe" (
    echo   [提示] 未找到 Electron，正在自动安装依赖（npm install）...
    echo   首次运行需要联网下载，请耐心等待。
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo   [错误] 依赖安装失败！请检查网络连接后重新运行。
        echo.
        pause
        exit /b 1
    )
    echo   [通过] 依赖安装完成
) else (
    echo   [通过] 依赖已就绪
)
echo.

REM ---------- 再次确认 Electron 可用 ----------
if not exist "node_modules\electron\dist\electron.exe" (
    echo   [错误] Electron 未正确安装，请手动运行：npm install
    echo.
    pause
    exit /b 1
)

REM ---------- 第 3 步：检测拖入的文件 ----------
echo [3/4] 检测启动参数...
if not "%~1"=="" (
    echo   [通过] 已接收到文件：%~nx1
    if not "%~2"=="" echo   [提示] 同时收到了多个文件，将一并打开
) else (
    echo   [提示] 未传入文件，将以空白窗口启动
)
echo.

REM ---------- 第 4 步：启动软件 ----------
echo [4/4] 正在启动 BBPlayer...
echo.
echo   软件窗口即将弹出，本窗口会保持显示日志。
echo ============================================================
echo.

"node_modules\electron\dist\electron.exe" . %*

echo.
echo   [信息] BBPlayer 已退出，测试结束。
echo.
pause
