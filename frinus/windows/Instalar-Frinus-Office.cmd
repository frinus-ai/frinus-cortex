@echo off
title Frinus Office - Instalador
echo Iniciando o instalador do Frinus Office. Quando o Windows perguntar, clique em "Sim".
rem Modo Office: o setup.ps1 do frinus-mcp instala o Frinus (Ubuntu/WSL, Claude Code, memoria) e o Frinus Office.
set FRINUS_PRODUCT=office
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072; iex (irm 'https://raw.githubusercontent.com/frinus-ai/frinus-mcp/client-installer-v11/install/setup.ps1' -UseBasicParsing)"
if errorlevel 1 pause
