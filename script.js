'use strict';

// --- DOM Elements ---
const videoPlayer = document.getElementById('videoPlayer');
const videoFileInput = document.getElementById('videoFile');
const srtFileInput = document.getElementById('srtFile');
const subtitleEditor = document.getElementById('subtitleEditor');
const editorPlaceholder = document.getElementById('editorPlaceholder');
const exportSrtButton = document.getElementById('exportSrtButton');
const seekBackwardButton = document.getElementById('seekBackward');
const seekForwardButton = document.getElementById('seekForward');
const contextMenu = document.getElementById('contextMenu');
const cmAddAbove = document.getElementById('cmAddAbove');
const cmAddBelow = document.getElementById('cmAddBelow');
const cmDelete = document.getElementById('cmDelete');

// --- State Variables ---
let subtitles = [];
let currentSubtitleIndex = -1; // Index of the subtitle active in the *editor list*
let activeCueIndex = -1; // Index of the subtitle cue currently showing on video
let originalFileName = 'edited_subtitles';
let longPressTimer = null;
const LONG_PRESS_DURATION = 600; // ms
let contextTargetIndex = -1; // Index of the item targeted by context menu
let currentTrackUrl = null; // To store and revoke the Blob URL
let videoLoaded = false;
let subtitlesLoaded = false;

// --- Utility Functions ---
function pad(num, size = 2) {
    let s = String(num);
    while (s.length < size) s = "0" + s;
    if (s.length > size && size === 3) s = s.substring(0, 3); // Ensure milliseconds are exactly 3 digits
    return s;
}

function timeToSeconds(timeString) {
    if (!timeString || typeof timeString !== 'string') {
        throw new Error(`Invalid input: "${timeString}"`);
    }
    try {
        const parts = timeString.split(':');
        if (parts.length !== 3) throw new Error("Incorrect time format structure.");
        const secondsParts = parts[2].replace(',', '.').split('.');
        if (secondsParts.length < 1 || secondsParts.length > 2) throw new Error("Incorrect seconds/milliseconds format.");

        const hours = parseInt(parts[0], 10);
        const minutes = parseInt(parts[1], 10);
        const seconds = parseInt(secondsParts[0], 10);
        const milliseconds = parseInt((secondsParts[1] || '0').padEnd(3, '0').substring(0, 3), 10);

        if (isNaN(hours) || isNaN(minutes) || isNaN(seconds) || isNaN(milliseconds) ||
            hours < 0 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59 || milliseconds < 0 || milliseconds > 999) {
            throw new Error("Invalid time component values.");
        }
        return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
    } catch (e) {
        console.error(`Error parsing time "${timeString}": ${e.message}`);
        throw new Error(`Invalid time format: "${timeString}"`);
    }
}

function secondsToTime(totalSeconds, useComma = true) {
    if (isNaN(totalSeconds) || totalSeconds === null || totalSeconds < 0) return useComma ? "00:00:00,000" : "00:00:00.000";
    totalSeconds = Math.max(0, totalSeconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const milliseconds = Math.round((totalSeconds % 1) * 1000);
    const separator = useComma ? ',' : '.';
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(milliseconds, 3)}`;
}

// --- UI Update Functions ---
function updateControlsState() {
    const videoReady = videoLoaded && videoPlayer.readyState >= 1; //readyState 1 means metadata loaded
    seekBackwardButton.disabled = !videoReady;
    seekForwardButton.disabled = !videoReady;
    exportSrtButton.disabled = !subtitlesLoaded || subtitles.length === 0;

    // Disable time setting buttons if video not ready
    subtitleEditor.querySelectorAll('.time-controls button').forEach(btn => {
         btn.disabled = !videoReady;
    });
}

function showPlaceholder(message) {
     subtitleEditor.innerHTML = ''; // Clear existing items
     if (!editorPlaceholder) {
         const p = document.createElement('p');
         p.id = 'editorPlaceholder';
         p.className = 'placeholder-text';
         subtitleEditor.appendChild(p);
         // editorPlaceholder = p; // Assign if needed globally, but usually accessing by ID is fine
     }
     const placeholderElem = document.getElementById('editorPlaceholder') || subtitleEditor.appendChild(document.createElement('p'));
     placeholderElem.id = 'editorPlaceholder';
     placeholderElem.className = 'placeholder-text';
     placeholderElem.textContent = message;
     placeholderElem.style.display = 'block';
}

function hidePlaceholder() {
    const placeholderElem = document.getElementById('editorPlaceholder');
    if(placeholderElem) placeholderElem.style.display = 'none';
}

// --- Core Logic ---
function parseSRT(data) {
    // Normalize line endings and trim whitespace
    data = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!data) return [];

    // Regex pattern: captures index, start time, end time, and text content
    // Allows comma or period for milliseconds, handles optional spaces around arrow
    // Captures multi-line text until the next blank line or end of file
    const pattern = /^(\d+)\s*\n(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*\n([\s\S]*?)(?=\n\n\d+|\n*$)/gm;
    let match;
    const subs = [];
    let expectedIndex = 1;

    while ((match = pattern.exec(data)) !== null) {
        const index = parseInt(match[1], 10);
        const startTimeStr = match[2];
        const endTimeStr = match[3];
        const text = match[4].trim();

        // Optional: Check for index sequence errors
        if (index !== expectedIndex) {
            console.warn(`SRT Parse Warning: Expected index ${expectedIndex}, but found ${index}.`);
            // You could choose to re-index or just warn
        }

        try {
            const startTime = timeToSeconds(startTimeStr);
            const endTime = timeToSeconds(endTimeStr);

            if (isNaN(startTime) || isNaN(endTime)) {
                console.warn(`SRT Parse Warning: Skipping entry ${index} due to invalid time conversion.`);
                continue; // Skip this entry
            }

            if (endTime <= startTime) {
                console.warn(`SRT Parse Warning: Entry ${index} has end time (${endTimeStr}) before or equal to start time (${startTimeStr}). Keeping original times.`);
                // Optionally adjust times here, e.g., endTime = startTime + 0.1;
            }

            if (!text) {
                 console.warn(`SRT Parse Warning: Entry ${index} has empty text.`);
            }

            subs.push({
                id: index, // Keep original ID for reference if needed
                startTime: startTime,
                endTime: endTime,
                text: text
            });
            expectedIndex = index + 1; // Update expected index based on the one found

        } catch (e) {
            console.warn(`SRT Parse Warning: Skipping entry near index ${index} due to error: ${e.message}`);
        }
    }

    if (subs.length === 0 && data.length > 10) { // Check if data wasn't just whitespace
        console.error("SRT parsing resulted in 0 subtitles, although input data was present. Check SRT format.");
        alert("لم يتم العثور على ترجمات صالحة في الملف. يرجى التحقق من تنسيق ملف SRT.");
    }

    // Sort by start time just in case the SRT wasn't ordered
    subs.sort((a, b) => a.startTime - b.startTime);

    return subs;
}

function generateWebVTT(subs) {
    let vttContent = "WEBVTT\n\n";
    subs.forEach((sub, index) => {
        // Ensure times are valid before adding
        if (typeof sub.startTime === 'number' && typeof sub.endTime === 'number' && sub.endTime > sub.startTime && sub.text) {
             // Use original ID or sequential index for cue identifier if needed (optional)
             // vttContent += `${sub.id || index + 1}\n`;
             vttContent += `${secondsToTime(sub.startTime, false)} --> ${secondsToTime(sub.endTime, false)}\n`;
             vttContent += `${sub.text.trim()}\n\n`;
        } else {
            console.warn(`Skipping invalid subtitle for VTT generation: Index ${index}`, sub);
        }
    });
    return vttContent;
}

function updateVideoTrack() {
    // 1. Clean up previous track and URL
    const oldTrack = videoPlayer.querySelector('track');
    if (oldTrack) {
        // Ensure the track is disabled before removing
        if (videoPlayer.textTracks && videoPlayer.textTracks.length > 0) {
             for (let i = 0; i < videoPlayer.textTracks.length; i++) {
                 if (videoPlayer.textTracks[i] === oldTrack.track) {
                      videoPlayer.textTracks[i].mode = 'disabled';
                      break;
                 }
             }
        }
        oldTrack.remove();
    }
    if (currentTrackUrl) {
        URL.revokeObjectURL(currentTrackUrl);
        currentTrackUrl = null;
    }
    activeCueIndex = -1; // Reset active cue tracking

    // 2. If no subtitles, ensure no track is active and exit
    if (!subtitles || subtitles.length === 0) {
        // Double-check no tracks are showing
        if (videoPlayer.textTracks && videoPlayer.textTracks.length > 0) {
             for (let i = 0; i < videoPlayer.textTracks.length; i++) {
                  if(videoPlayer.textTracks[i].mode === 'showing') videoPlayer.textTracks[i].mode = 'disabled';
             }
        }
        return;
    }

    // 3. Generate VTT content
    const vttContent = generateWebVTT(subtitles);
    if (!vttContent || !vttContent.includes("-->")) {
        console.warn("Generated VTT content is empty or invalid.");
        return; // Don't add an empty/invalid track
    }

    // 4. Create Blob, URL, and new track element
    const blob = new Blob([vttContent], { type: 'text/vtt;charset=utf-8' });
    currentTrackUrl = URL.createObjectURL(blob);

    const trackElement = document.createElement('track');
    trackElement.kind = 'subtitles';
    trackElement.label = 'العربية (مُعدّل)'; // Label indicating it's the edited version
    trackElement.srclang = 'ar';
    trackElement.src = currentTrackUrl;
    trackElement.default = true; // Make it the default track

    // 5. Add the track to the video player
    videoPlayer.appendChild(trackElement);

    // 6. Activate the track (defer slightly to allow browser processing)
    // Important: Access the track via videoPlayer.textTracks AFTER adding it
    setTimeout(() => {
        if (videoPlayer.textTracks && videoPlayer.textTracks.length > 0) {
             let trackActivated = false;
             // Find the newly added track (often the last one)
             for (let i = videoPlayer.textTracks.length - 1; i >= 0; i--) {
                  // Check if the track object exists and matches kind/label/url (url might be tricky)
                 if (videoPlayer.textTracks[i].kind === 'subtitles' && videoPlayer.textTracks[i].label === trackElement.label) {
                      videoPlayer.textTracks[i].mode = 'showing';
                      trackActivated = true;
                      // console.log('Activated track:', videoPlayer.textTracks[i]);

                      // Add cue change listener to the specific track
                      videoPlayer.textTracks[i].oncuechange = handleCueChange;

                      break;
                 }
             }
            if (!trackActivated) {
                 console.warn("Could not definitively find and activate the newly added track by label. Attempting to activate the first subtitles track.");
                 // Fallback: try activating the first subtitle track if available
                  if(videoPlayer.textTracks[0] && videoPlayer.textTracks[0].kind === 'subtitles') {
                       videoPlayer.textTracks[0].mode = 'showing';
                       videoPlayer.textTracks[0].oncuechange = handleCueChange;
                  }
            }
        } else {
            console.warn("Text tracks API not ready when trying to set mode.");
        }
        updateHighlight(true); // Force scroll after track activation attempt
    }, 150); // Increased delay slightly
}

function renderSubtitles() {
    subtitleEditor.innerHTML = ''; // Clear previous items
    hidePlaceholder();

    if (!subtitles || subtitles.length === 0) {
        showPlaceholder(subtitlesLoaded ? 'لا توجد ترجمات لعرضها.' : 'قم بتحميل ملف SRT لعرض الترجمة.');
        updateVideoTrack(); // Ensure track is removed if subtitles are cleared
        updateControlsState();
        return;
    }

    // Sort subtitles just before rendering to be sure
    subtitles.sort((a, b) => a.startTime - b.startTime);

    const fragment = document.createDocumentFragment();

    subtitles.forEach((sub, index) => {
        const item = document.createElement('div');
        item.classList.add('subtitle-item');
        item.dataset.index = index; // Use index in the current array for referencing

        // Time Controls Div
        const timeControls = document.createElement('div');
        timeControls.classList.add('time-controls');

        // Start Time Input
        const startTimeInput = document.createElement('input');
        startTimeInput.type = 'text';
        startTimeInput.value = secondsToTime(sub.startTime);
        startTimeInput.title = `وقت البدء (HH:MM:SS,ms)`;
        startTimeInput.dataset.type = 'start';
        startTimeInput.addEventListener('change', (e) => handleTimeInputChange(e, index, 'startTime'));
        startTimeInput.addEventListener('focus', (e) => e.target.select()); // Select text on focus

        // Set Start Button
        const setStartBtn = document.createElement('button');
        setStartBtn.textContent = '↦ ابدأ';
        setStartBtn.title = 'ضبط وقت البدء للوقت الحالي للفيديو';
        setStartBtn.disabled = !videoLoaded; // Disable if video not ready
        setStartBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent item click
            setTimeFromVideo(index, 'startTime');
        });

        // Separator
        const timeSeparator = document.createElement('span');
        timeSeparator.classList.add('time-separator');
        timeSeparator.textContent = '-->';

        // End Time Input
        const endTimeInput = document.createElement('input');
        endTimeInput.type = 'text';
        endTimeInput.value = secondsToTime(sub.endTime);
        endTimeInput.title = `وقت الانتهاء (HH:MM:SS,ms)`;
        endTimeInput.dataset.type = 'end';
        endTimeInput.addEventListener('change', (e) => handleTimeInputChange(e, index, 'endTime'));
        endTimeInput.addEventListener('focus', (e) => e.target.select());

        // Set End Button
        const setEndBtn = document.createElement('button');
        setEndBtn.textContent = 'انتهاء ↦';
        setEndBtn.title = 'ضبط وقت الانتهاء للوقت الحالي للفيديو';
        setEndBtn.disabled = !videoLoaded;
        setEndBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            setTimeFromVideo(index, 'endTime');
        });

        // Assemble Time Controls
        timeControls.appendChild(setStartBtn);
        timeControls.appendChild(startTimeInput);
        timeControls.appendChild(timeSeparator);
        timeControls.appendChild(endTimeInput);
        timeControls.appendChild(setEndBtn);

        // Text Area
        const textArea = document.createElement('textarea');
        textArea.value = sub.text;
        textArea.rows = Math.max(1, sub.text.split('\n').length); // Min 1 row
        textArea.dir = "auto"; // Auto direction based on content
        textArea.title = "نص الترجمة";
        // Use 'input' for immediate feedback, consider debouncing for very large files if needed
        textArea.addEventListener('input', (e) => {
             if (subtitles[index]) { // Ensure subtitle still exists
                 subtitles[index].text = e.target.value;
                 // Adjust height dynamically based on content, within limits
                 textArea.rows = Math.max(1, e.target.value.split('\n').length);
                 updateVideoTrack(); // Update track immediately on text change
             }
        });
        // Prevent item click/context menu when interacting with textarea
        textArea.addEventListener('click', (e) => e.stopPropagation());
        textArea.addEventListener('contextmenu', (e) => e.stopPropagation());
        textArea.addEventListener('touchstart', (e) => e.stopPropagation()); // Prevent triggering long press on text area

        // Assemble Item
        item.appendChild(timeControls);
        item.appendChild(textArea);

        // --- Item Event Listeners ---
        // Click to seek video
        item.addEventListener('click', () => {
            if (videoLoaded && videoPlayer.readyState >= 1 && subtitles[index]) {
                videoPlayer.currentTime = subtitles[index].startTime;
                // Optional: Play if paused
                // if (videoPlayer.paused) videoPlayer.play();
            }
        });

        // Context Menu Trigger (Right-click for Desktop)
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showContextMenu(index, item);
        });

        // Context Menu Trigger (Long Press for Mobile)
        item.addEventListener('touchstart', (e) => {
             // Don't start timer if interaction is on input/button/textarea
             if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.tagName === 'TEXTAREA') return;
            clearTimeout(longPressTimer); // Clear previous timer
            longPressTimer = setTimeout(() => {
                showContextMenu(index, item);
                // Optional: Vibrate slightly on long press for feedback
                if ('vibrate' in navigator) navigator.vibrate(50);
            }, LONG_PRESS_DURATION);
        });
        // Cancel long press if finger moves or touch ends too soon
        item.addEventListener('touchmove', () => clearTimeout(longPressTimer));
        item.addEventListener('touchend', () => clearTimeout(longPressTimer));
        item.addEventListener('touchcancel', () => clearTimeout(longPressTimer));


        fragment.appendChild(item);
    });

    subtitleEditor.appendChild(fragment);
    updateVideoTrack(); // Update track after rendering all items
    updateHighlight(true); // Update highlight and scroll if needed
    updateControlsState(); // Update button states
}

// --- Highlighting and Synchronization ---
function isElementInViewport(el, container) {
    if (!el) return false;
    const elRect = el.getBoundingClientRect();
    // If no container specified, use viewport
    const containerRect = container ? container.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    // Check if top and bottom are within the container's visible area
    return elRect.top >= containerRect.top && elRect.bottom <= containerRect.bottom;
}

function updateHighlight(forceScroll = false) {
    if (!subtitles || subtitles.length === 0 || !videoLoaded) return;

    const currentTime = videoPlayer.currentTime;
    let newActiveIndex = -1;

    // Find the subtitle index that matches the current video time
    // Use the activeCues if available for better accuracy
    if (videoPlayer.textTracks && videoPlayer.textTracks.length > 0 && videoPlayer.textTracks[0].activeCues && videoPlayer.textTracks[0].activeCues.length > 0) {
         // Assuming cues generated by generateWebVTT correspond 1:1 with subtitles array
         // This might be fragile if generateWebVTT skips items.
         // A safer way is to re-find based on time.
        // const activeCue = videoPlayer.textTracks[0].activeCues[0];
        // newActiveIndex = subtitles.findIndex(sub => sub.startTime === activeCue.startTime && sub.endTime === activeCue.endTime);
    }

    // If no active cue or couldn't match, find by time (more reliable)
    if (newActiveIndex === -1) {
         for (let i = 0; i < subtitles.length; i++) {
             if (currentTime >= subtitles[i].startTime && currentTime < subtitles[i].endTime) {
                 newActiveIndex = i;
                 break;
             }
         }
    }


    if (newActiveIndex !== currentSubtitleIndex) {
        // Remove highlight from the previously active item
        const previousItem = subtitleEditor.querySelector(`.subtitle-item.active`);
        if (previousItem) previousItem.classList.remove('active');

        // Add highlight to the new active item
        if (newActiveIndex !== -1) {
            const currentItem = subtitleEditor.querySelector(`.subtitle-item[data-index="${newActiveIndex}"]`);
            if (currentItem) {
                currentItem.classList.add('active');
                // Scroll into view if needed
                // Use subtitleEditor as the scroll parent
                if (forceScroll || !isElementInViewport(currentItem, subtitleEditor)) {
                     // Use 'nearest' to avoid unnecessary large scrolls if partially visible
                     currentItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            }
        }
        currentSubtitleIndex = newActiveIndex; // Update the tracked index
    }
}

// Function to handle cue changes directly from the TextTrack
function handleCueChange(event) {
    const track = event.target; // The TextTrack that fired the event
    if (track.activeCues && track.activeCues.length > 0) {
        const activeCue = track.activeCues[0];
        // Find the corresponding subtitle index based on timing
        // This assumes our subtitles array is sorted
        const newIndex = subtitles.findIndex(sub =>
             Math.abs(sub.startTime - activeCue.startTime) < 0.01 &&
             Math.abs(sub.endTime - activeCue.endTime) < 0.01
        );
        activeCueIndex = newIndex; // Update index based on cue
        updateHighlight(); // Call highlight update without forcing scroll initially
    } else {
        // No active cues, remove highlight
        activeCueIndex = -1;
        updateHighlight();
    }
}


// --- Editing Functions ---
function handleTimeInputChange(event, index, timeType) {
    if (!subtitles[index]) return; // Check if item still exists

    const inputElement = event.target;
    const newTimeString = inputElement.value.trim();
    inputElement.classList.remove('error'); // Reset error state

    try {
        const newSeconds = timeToSeconds(newTimeString);
        const otherTimeType = timeType === 'startTime' ? 'endTime' : 'startTime';
        const otherSeconds = subtitles[index][otherTimeType];

        // Basic validation: start must be < end
        if ((timeType === 'startTime' && newSeconds >= otherSeconds) ||
            (timeType === 'endTime' && newSeconds <= otherSeconds)) {
            throw new Error(`${timeType === 'startTime' ? 'Start' : 'End'} time must be strictly ${timeType === 'startTime' ? 'before' : 'after'} ${otherTimeType} time.`);
        }

        // Optional: Add validation against adjacent subtitles
        if (timeType === 'startTime' && index > 0 && newSeconds <= subtitles[index - 1].endTime) {
             // console.warn(`Overlap Warning: Start time ${newSeconds} overlaps previous subtitle end time ${subtitles[index - 1].endTime}`);
             // Optionally add visual indicator or prevent? For now, just warn.
        }
        if (timeType === 'endTime' && index < subtitles.length - 1 && newSeconds >= subtitles[index + 1].startTime) {
             // console.warn(`Overlap Warning: End time ${newSeconds} overlaps next subtitle start time ${subtitles[index + 1].startTime}`);
        }


        subtitles[index][timeType] = newSeconds;
        // Reformat input value to ensure consistency HH:MM:SS,ms
        inputElement.value = secondsToTime(newSeconds);
        updateVideoTrack(); // Update track immediately after valid time change

    } catch (error) {
        inputElement.classList.add('error');
        console.error(`Time input error for index ${index}, type ${timeType}:`, error);
        alert(`خطأ في تنسيق الوقت: ${error.message}\nالتنسيق المطلوب: HH:MM:SS,ms (مثال: 00:01:23,456)`);
        // Optional: revert input value?
        // inputElement.value = secondsToTime(subtitles[index][timeType]);
    }
}

function setTimeFromVideo(index, timeType) {
    if (!subtitles[index] || !videoLoaded || videoPlayer.readyState < 1) return;

    const currentTime = videoPlayer.currentTime;
    const otherTimeType = timeType === 'startTime' ? 'endTime' : 'startTime';
    const otherSeconds = subtitles[index][otherTimeType];

    // Prevent setting start >= end or end <= start
    if ((timeType === 'startTime' && currentTime >= otherSeconds) ||
        (timeType === 'endTime' && currentTime <= otherSeconds)) {
        alert(`خطأ: وقت ${timeType === 'startTime' ? 'البدء' : 'الانتهاء'} المحدد (${secondsToTime(currentTime)}) غير صالح بالنسبة لوقت ${otherTimeType === 'startTime' ? 'البدء' : 'الانتهاء'} الحالي (${secondsToTime(otherSeconds)}).`);
        return;
    }

    // Update data
    subtitles[index][timeType] = currentTime;

    // Update UI input field immediately
    const itemElement = subtitleEditor.querySelector(`.subtitle-item[data-index="${index}"]`);
    if (itemElement) {
        const inputElement = itemElement.querySelector(`input[data-type="${timeType === 'startTime' ? 'start' : 'end'}"]`);
        if (inputElement) {
            inputElement.value = secondsToTime(currentTime);
            inputElement.classList.remove('error'); // Clear error state if any
        }
    }

    updateVideoTrack(); // Update the live preview
}

// --- Context Menu Functions ---
function showContextMenu(index, itemElement) {
    if (index < 0 || index >= subtitles.length) return; // Validate index

    hideContextMenu(); // Hide any previous menu

    contextTargetIndex = index;
    itemElement.classList.add('context-selected'); // Highlight selected item

    // Calculate position
    const itemRect = itemElement.getBoundingClientRect();
    const menuHeight = contextMenu.offsetHeight || 130; // Estimate if not rendered
    const menuWidth = contextMenu.offsetWidth || 150;
    const PADDING = 10; // Padding from window edges

    let top, left;

    // Position vertically: prefer below, fallback to above
    if (itemRect.bottom + menuHeight + PADDING < window.innerHeight) {
        top = itemRect.bottom + window.scrollY;
    } else if (itemRect.top - menuHeight - PADDING > 0) {
        top = itemRect.top + window.scrollY - menuHeight;
    } else {
        // Fallback if no space above or below (rare)
        top = Math.max(PADDING, window.innerHeight - menuHeight - PADDING) + window.scrollY;
    }

     // Position horizontally: align left with item (for RTL, this means right edge of item)
     // Adjust if it goes off-screen
     left = itemRect.left + window.scrollX; // Use left for RTL as well, CSS handles visual alignment
     if (left + menuWidth + PADDING > window.innerWidth) {
         left = window.innerWidth - menuWidth - PADDING; // Adjust left if too far right
     }
     if (left < PADDING) {
         left = PADDING; // Adjust if too far left
     }


    contextMenu.style.top = `${Math.max(0, top)}px`;
    contextMenu.style.left = `${Math.max(0, left)}px`;
    contextMenu.style.display = 'block';
}

function hideContextMenu() {
    const selectedItem = subtitleEditor.querySelector('.subtitle-item.context-selected');
    if (selectedItem) {
        selectedItem.classList.remove('context-selected');
    }
    if (contextMenu.style.display === 'block') {
        contextMenu.style.display = 'none';
    }
    contextTargetIndex = -1; // Reset target index
}

function addSubtitle(refIndex, position) {
    if (refIndex < 0 || refIndex >= subtitles.length) return;

    const refSub = subtitles[refIndex];
    const DEFAULT_DURATION = 2.5; // Default duration for new subtitle
    const MIN_GAP = 0.01; // Minimum gap between subtitles
    let newStartTime, newEndTime;

    if (position === 'above') {
        const prevEndTime = (refIndex > 0) ? subtitles[refIndex - 1].endTime : 0;
        // Place it halfway between previous end and current start, or DEFAULT_DURATION before current start
        newStartTime = Math.max(prevEndTime + MIN_GAP, refSub.startTime - DEFAULT_DURATION - MIN_GAP);
        newEndTime = Math.min(refSub.startTime - MIN_GAP, newStartTime + DEFAULT_DURATION);
        // Ensure minimum duration and valid ordering
        if (newEndTime <= newStartTime) newEndTime = newStartTime + 0.1;
        newEndTime = Math.min(refSub.startTime - MIN_GAP, newEndTime); // Re-check against refSub start
        newStartTime = Math.max(prevEndTime + MIN_GAP, newStartTime); // Re-check against prevSub end

    } else { // 'below'
        const nextStartTime = (refIndex < subtitles.length - 1) ? subtitles[refIndex + 1].startTime : (videoPlayer.duration || refSub.endTime + 10); // Use video duration if available
        // Place it halfway between current end and next start, or DEFAULT_DURATION after current end
        newStartTime = Math.max(refSub.endTime + MIN_GAP, refSub.endTime); // Start immediately after or with gap
        newEndTime = Math.min(nextStartTime - MIN_GAP, newStartTime + DEFAULT_DURATION);
        // Ensure minimum duration and valid ordering
        if (newEndTime <= newStartTime) newEndTime = newStartTime + 0.1;
         newStartTime = Math.max(refSub.endTime + MIN_GAP, newStartTime); // Re-check against refSub end
         newEndTime = Math.min(nextStartTime - MIN_GAP, newEndTime); // Re-check against nextSub start
    }

    // Ensure times are non-negative and end is after start
     newStartTime = Math.max(0, newStartTime);
     newEndTime = Math.max(newStartTime + 0.1, newEndTime); // Ensure min duration 0.1s

    const newSub = {
        id: -1, // Or generate a unique ID if needed
        startTime: newStartTime,
        endTime: newEndTime,
        text: "سطر جديد..."
    };

    const insertIndex = (position === 'above') ? refIndex : refIndex + 1;
    subtitles.splice(insertIndex, 0, newSub);

    renderSubtitles(); // Re-render the entire list and update track

    // Scroll to and focus the new item
    const newItem = subtitleEditor.querySelector(`.subtitle-item[data-index="${insertIndex}"]`);
    if (newItem) {
         setTimeout(() => { // Delay focus slightly after render
             newItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
             const newTextArea = newItem.querySelector('textarea');
             if (newTextArea) {
                 newTextArea.focus();
                 newTextArea.select();
             }
         }, 100);
    }
}

function deleteSubtitle(index) {
    if (index < 0 || index >= subtitles.length) return;
    const textPreview = subtitles[index].text.substring(0, 50);
    if (confirm(`هل أنت متأكد من حذف هذا السطر؟\n"${textPreview}..."`)) {
        subtitles.splice(index, 1);
        renderSubtitles(); // Re-render and update track
    }
}

// --- File Handling and Export ---
function handleVideoFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Revoke previous object URL if one exists
    if (videoPlayer.src && videoPlayer.src.startsWith('blob:')) {
         URL.revokeObjectURL(videoPlayer.src);
    }

    const fileURL = URL.createObjectURL(file);
    videoPlayer.src = fileURL;
    videoLoaded = false; // Reset loaded state until metadata loads
    updateControlsState(); // Disable controls initially

    let videoName = file.name.substring(0, file.name.lastIndexOf('.')) || 'video';
    originalFileName = `${videoName}_edited`; // Base for export filename

    // Add event listeners for video loading states
    videoPlayer.onloadedmetadata = () => {
         videoLoaded = true;
         console.log("Video metadata loaded. Duration:", videoPlayer.duration);
         updateControlsState();
         updateHighlight(true); // Update highlight based on initial time (usually 0)
    };
     videoPlayer.onerror = (e) => {
          console.error("Video loading error:", videoPlayer.error);
          alert(`حدث خطأ أثناء تحميل الفيديو: ${videoPlayer.error?.message || 'خطأ غير معروف'}`);
          videoLoaded = false;
          updateControlsState();
     };
     videoPlayer.oncanplay = () => {
          videoLoaded = true; // Redundant if onloadedmetadata worked, but safe fallback
          updateControlsState();
     };

     // If no SRT loaded yet, show appropriate placeholder
     if (!subtitlesLoaded) {
          showPlaceholder("تم تحميل الفيديو. قم بتحميل ملف SRT.");
     }
}

function handleSrtFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        const srtContent = e.target.result;
        try {
            subtitles = parseSRT(srtContent);
            subtitlesLoaded = true;
            console.log(`Parsed ${subtitles.length} subtitles.`);
            renderSubtitles(); // This will render, update track, and update controls
        } catch (error) {
            console.error('Error parsing SRT file:', error);
            alert(`حدث خطأ أثناء تحليل ملف SRT: ${error.message}`);
            subtitles = [];
            subtitlesLoaded = false;
            renderSubtitles(); // Show error placeholder
        }
    };
    reader.onerror = () => {
        console.error('Error reading SRT file.');
        alert('لا يمكن قراءة ملف SRT المحدد.');
        subtitles = [];
        subtitlesLoaded = false;
        renderSubtitles(); // Show error placeholder
    };
    reader.readAsText(file, 'UTF-8'); // Specify UTF-8 encoding
}

function exportSRT() {
    if (!subtitles || subtitles.length === 0) {
        alert('لا يوجد ترجمة لتصديرها!');
        return;
    }

    // Always sort before export for safety
    subtitles.sort((a, b) => a.startTime - b.startTime);

    let srtOutput = '';
    let invalidTimingFound = false;
    let lastEndTime = 0;

    subtitles.forEach((sub, index) => {
        // Validation Checks during export
        if (sub.endTime <= sub.startTime) {
             console.error(`Export Warning: Invalid timing for line ${index + 1} (End <= Start). Start: ${secondsToTime(sub.startTime)}, End: ${secondsToTime(sub.endTime)}`);
             invalidTimingFound = true;
        }
        if (sub.startTime < lastEndTime) {
             console.warn(`Export Warning: Overlap detected for line ${index + 1}. Start time ${secondsToTime(sub.startTime)} is before previous end time ${secondsToTime(lastEndTime)}.`);
             // Don't set invalidTimingFound = true for overlaps, just warn
        }
        if (!sub.text.trim()) {
             console.warn(`Export Warning: Line ${index + 1} has empty text.`);
        }

        // Generate SRT entry (using sequential 1-based index)
        srtOutput += (index + 1) + '\n';
        srtOutput += `${secondsToTime(sub.startTime, true)} --> ${secondsToTime(sub.endTime, true)}\n`; // Use comma for SRT
        srtOutput += sub.text.trim() + '\n\n'; // Add two newlines

        lastEndTime = sub.endTime; // Update last end time for overlap check
    });

    if (invalidTimingFound) {
         if (!confirm("تحذير: تم العثور على أخطاء في التوقيت (وقت الانتهاء قبل أو يساوي وقت البدء) في بعض الأسطر.\nقد لا يعمل الملف الناتج بشكل صحيح.\n\nهل ترغب في متابعة التصدير على أي حال؟")) {
              return; // Abort export if user cancels
         }
    }

    // Create Blob and Download Link
    // Force BOM for better compatibility with some Windows software
    const BOM = "\uFEFF";
    const blob = new Blob([BOM + srtOutput], { type: 'text/srt;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `${originalFileName}.srt`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click(); // Simulate click to trigger download
    document.body.removeChild(link); // Clean up the link element
    URL.revokeObjectURL(url); // Release the Blob URL resource

    console.log("SRT file exported.");
}


// --- Event Listener Setup ---
function initializeApp() {
    // File Inputs
    videoFileInput.addEventListener('change', handleVideoFile);
    srtFileInput.addEventListener('change', handleSrtFile);

    // Video Player Events
    videoPlayer.addEventListener('timeupdate', () => updateHighlight()); // Don't force scroll on timeupdate
     videoPlayer.addEventListener('play', updateControlsState);
     videoPlayer.addEventListener('pause', updateControlsState);
     videoPlayer.addEventListener('ended', updateControlsState);
    // Add listener for seeking completed to force scroll after manual seek
    videoPlayer.addEventListener('seeked', () => updateHighlight(true));

    // Seek Buttons
    seekBackwardButton.addEventListener('click', () => {
        if (videoLoaded && videoPlayer.readyState > 0) videoPlayer.currentTime = Math.max(0, videoPlayer.currentTime - 5);
    });
    seekForwardButton.addEventListener('click', () => {
        if (videoLoaded && videoPlayer.readyState > 0 && videoPlayer.duration) videoPlayer.currentTime = Math.min(videoPlayer.duration, videoPlayer.currentTime + 5);
    });

    // Export Button
    exportSrtButton.addEventListener('click', exportSRT);

    // Context Menu Buttons
    cmAddAbove.addEventListener('click', () => { if (contextTargetIndex !== -1) addSubtitle(contextTargetIndex, 'above'); hideContextMenu(); });
    cmAddBelow.addEventListener('click', () => { if (contextTargetIndex !== -1) addSubtitle(contextTargetIndex, 'below'); hideContextMenu(); });
    cmDelete.addEventListener('click', () => { if (contextTargetIndex !== -1) deleteSubtitle(contextTargetIndex); hideContextMenu(); });

    // Global Listeners to hide context menu
    document.addEventListener('click', (e) => {
        // Hide if click is outside the context menu itself AND not on a subtitle item's non-interactive part
        if (!contextMenu.contains(e.target) && !e.target.closest('.subtitle-item[data-index]')) {
            hideContextMenu();
        } else if (e.target.closest('.subtitle-item') && !contextMenu.contains(e.target) && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') {
             // Hide if clicking on item background but not the menu
             hideContextMenu();
        }
    });
    // Use capture phase for scroll to hide menu immediately on scroll start
    window.addEventListener('scroll', hideContextMenu, true);

    // Initial UI State
    showPlaceholder("قم بتحميل الفيديو وملف SRT للبدء...");
    updateControlsState();
}

// --- Run Initialization ---
initializeApp();