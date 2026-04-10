const TAG = "[PopupToTab]";
let processingTabs = new Set();

/**
 * 기능 활성화 상태 확인
 * Check if the feature is enabled
 */
const getEnabledState = async () => {
  try {
    const result = await chrome.storage.local.get("enabled");
    
    // 최초 실행 시 undefined이면 true(ON)로 간주
    // Default to true if not set (default is ON)
    return result.enabled === undefined ? true : result.enabled;
  } catch (e) {
    console.error(`${TAG} Failed to get enabled state:`, e);
    return true;
  }
};

/**
 * 탭을 그룹에 확실히 포함시키는 함수
 * Ensure tab is added to the correct group
 */
const ensureTabInGroup = async (tabId, groupId) => {
  if (!groupId || groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return;
  
  const MAX_RETRIES = 5;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      await chrome.tabs.group({ tabIds: [tabId], groupId: groupId });
      return;
    } catch (e) {
      if (i === MAX_RETRIES - 1) {
        console.error(`${TAG} Final grouping attempt failed:`, e);
      }
      
      // 상태 동기화를 위해 대기
      // Wait for state synchronization
      await new Promise(r => setTimeout(r, 200));
    }
  }
};

/**
 * 뱃지 상태 업데이트
 * Update the extension's badge status
 */
const updateBadgeStatus = async () => {
  const enabled = await getEnabledState();
  const text = enabled ? "ON" : "OFF";
  const color = enabled ? "#4CAF50" : "#F44336";
  
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch (e) {
    // 초기화 시점 예외 무시
    // Ignore errors during early initialization
  }
};

/**
 * 초기 설치 및 서비스 워커 실행
 * Initial setup and service worker execution
 */
chrome.runtime.onInstalled.addListener(updateBadgeStatus);
updateBadgeStatus();

/**
 * 확장 프로그램 아이콘 클릭 시 토글
 * Toggle feature on icon click
 */
chrome.action.onClicked.addListener(async () => {
  const currentState = await getEnabledState();
  const newState = !currentState;
  await chrome.storage.local.set({ enabled: newState });
  await updateBadgeStatus();
});

/**
 * 탭 생성 이벤트 리스너 (메인 로직)
 * Tab creation listener (Main logic)
 */
chrome.tabs.onCreated.addListener(async (tab) => {
  // 1. 이미 처리 중인 탭이면 중단
  // Skip if already being processed
  if (processingTabs.has(tab.id)) return;
  
  const isEnabled = await getEnabledState();
  if (!isEnabled) return;

  try {
    const currentTab = await chrome.tabs.get(tab.id).catch(() => null);
    if (!currentTab) return;

    // 2. 팝업 창인지 확인
    // Verify if it is a popup window
    const sourceWin = await chrome.windows.get(currentTab.windowId).catch(() => null);
    if (!sourceWin || sourceWin.type !== 'popup') return;

    // 중복 실행 방지 락 설정
    // Set lock to prevent duplicate execution
    processingTabs.add(tab.id);

    // 3. URL 로드 대기 (최대 2초)
    // Wait for URL to load (Max 2s)
    let finalTab = currentTab;
    for (let i = 0; i < 10; i++) {
      if (finalTab.url && finalTab.url !== 'about:blank' && !finalTab.url.startsWith('chrome://newtab')) break;
      await new Promise(r => setTimeout(r, 200));
      finalTab = await chrome.tabs.get(tab.id).catch(() => null);
      if (!finalTab) break;
    }

    if (!finalTab || !finalTab.url || finalTab.url === 'about:blank') {
      processingTabs.delete(tab.id);
      return;
    }

    // 4. 대상 일반 창 찾기
    // Find a target normal window
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    let targetWin = windows.find(w => w.focused) || windows[0];
    if (!targetWin) {
      processingTabs.delete(tab.id);
      return;
    }

    // 5. 위치 및 그룹 정보 분석
    // Analyze position and group info
    let targetGroupId = chrome.tabGroups.TAB_GROUP_ID_NONE;
    let targetIndex = undefined;

    let parentTab = null;
    if (finalTab.openerTabId) {
      parentTab = await chrome.tabs.get(finalTab.openerTabId).catch(() => null);
    }

    // 부모 탭이 없으면 현재 활성 탭 기준
    // Use active tab if parent is missing
    if (!parentTab || parentTab.windowId !== targetWin.id) {
      const activeTabs = await chrome.tabs.query({ windowId: targetWin.id, active: true });
      parentTab = activeTabs[0] || null;
    }

    if (parentTab) {
      targetGroupId = parentTab.groupId;
      targetIndex = parentTab.index + 1;
    }

    // 6. 더미 탭 버퍼 전략 (크래시 방지 및 opener 유지)
    // Dummy Tab Buffer Strategy (Prevent crash & preserve opener)
    // 팝업 창의 유일한 탭을 이동할 때 브라우저가 종료되는 버그를 방지하기 위해
    // 팝업 창에 임시 탭을 생성하여 '빈 창' 상태가 되지 않도록 보호합니다.
    // To prevent browser crashes when moving the last tab of a popup,
    // we create a temporary dummy tab to ensure the window is never empty.
    
    try {
      // 탭 상태가 안정화될 때까지 대기
      // Wait for tab state to stabilize
      await new Promise(r => setTimeout(r, 200));
      
      const checkTab = await chrome.tabs.get(tab.id).catch(() => null);
      if (!checkTab) throw new Error("Tab lost during initialization");

      // [Step 1] 팝업 창이 닫히지 않도록 임시 더미 탭 생성
      // 이 더미 탭 덕분에 실제 탭이 빠져나가도 브라우저가 크래시되지 않습니다.
      // [Step 1] Create a dummy tab to keep the popup window open
      // This prevents the browser from crashing when the actual tab is moved out.
      await chrome.tabs.create({
        windowId: sourceWin.id,
        url: "about:blank",
        active: false
      }).catch(() => null);

      // [Step 2] 실제 탭을 대상 창으로 이동 (window.opener가 유지됨)
      // [Step 2] Move the actual tab to the target window (Preserves window.opener)
      await chrome.tabs.move(tab.id, {
        windowId: targetWin.id,
        index: targetIndex
      });

      // [Step 3] 이동된 탭 활성화 및 그룹화
      // [Step 3] Activate and group the moved tab
      await chrome.tabs.update(tab.id, { active: true });
      if (targetGroupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        await ensureTabInGroup(tab.id, targetGroupId);
      }

      // [Step 4] 이제 안전하게 기존 팝업 창 전체 제거
      // [Step 4] Safely remove the original popup window
      await chrome.windows.remove(sourceWin.id).catch(() => {});

    } catch (moveError) {
      console.warn(`${TAG} Move failed, using Recreate as fallback:`, moveError);
      
      // [Fallback] 이동 실패 시에만 새로 생성 (이 경우 JS 레벨 opener는 유실될 수 있음)
      // [Fallback] Recreate the tab if move fails (JS-level opener object may be lost)
      const newTab = await chrome.tabs.create({
        windowId: targetWin.id,
        index: targetIndex,
        url: finalTab.url,
        openerTabId: finalTab.openerTabId || undefined,
        active: true
      });

      if (targetGroupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        await ensureTabInGroup(newTab.id, targetGroupId);
      }
      await chrome.windows.remove(sourceWin.id).catch(() => {});
    }

  } catch (error) {
    console.error(`${TAG} Critical Error:`, error);
  } finally {
    // 2초 후 락 해제
    // Release lock after 2 seconds
    setTimeout(() => processingTabs.delete(tab.id), 2000);
  }
});
