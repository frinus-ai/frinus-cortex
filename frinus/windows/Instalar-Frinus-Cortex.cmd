@echo off
title Frinus Cortex - Instalador
echo Iniciando o instalador do Frinus Cortex. Quando o Windows perguntar, clique em "Sim".
rem Produto "office": o setup.ps1 do frinus-mcp instala o Frinus (Ubuntu/WSL, Claude Code, memoria) e o Frinus Cortex.
set FRINUS_PRODUCT=office
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072; iex (irm 'https://raw.githubusercontent.com/frinus-ai/frinus-mcp/client-installer-v13/install/setup.ps1' -UseBasicParsing)"
if errorlevel 1 pause
