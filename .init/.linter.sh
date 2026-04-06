#!/bin/bash
cd /home/kavia/workspace/code-generation/ai-code-assistant-for-visual-studio-code-339349-339364/react_webview_ui
npm run build
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
   exit 1
fi

