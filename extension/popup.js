'use strict';

// 「タグの管理」リンク → オプションページを開く。
// 標準の openOptionsPage が失敗した場合は options.html を直接タブで開く。
document.getElementById('open-options').addEventListener('click', (e) => {
  e.preventDefault();
  const openDirect = () => chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  try {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage(() => {
        if (chrome.runtime.lastError) openDirect();
      });
    } else {
      openDirect();
    }
  } catch (err) {
    openDirect();
  }
  window.close();
});
