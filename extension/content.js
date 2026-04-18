// ==========================================
// Ky's Canvas — Content Script (v3.5)
// Browser-extension build of the Tampermonkey userscript
// ==========================================

(async function () {
    'use strict';

    // Cross-browser API shim
    const api = (typeof browser !== 'undefined') ? browser : chrome;

    // ---------- Auto-disable on quiz pages ----------
    // Matches /courses/<id>/quizzes and anything below it.
    if (/\/courses\/\d+\/quizzes(\/|$)/.test(window.location.pathname)) {
        console.log("[Ky's Canvas] Auto-disabled on quiz page.");
        return;
    }

    // ---------- Check global on/off toggle ----------
    let enabled = true;
    try {
        const result = await api.storage.local.get({ enabled: true });
        enabled = result.enabled;
    } catch (e) {
        console.warn("[Ky's Canvas] storage read failed, defaulting to enabled", e);
    }
    if (!enabled) {
        console.log("[Ky's Canvas] Extension disabled via popup toggle.");
        // Still listen for re-enable
        api.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes.enabled && changes.enabled.newValue === true) {
                location.reload();
            }
        });
        return;
    }

    // Reload if the user flips the switch off while on a Canvas page
    api.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.enabled && changes.enabled.newValue === false) {
            location.reload();
        }
    });

    // GM_addStyle replacement — inject a <style> tag
    function addStyle(css) {
        const style = document.createElement('style');
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    }

    // ==========================================
    // 1. STATE MANAGEMENT & PERSISTENCE
    // ==========================================

    const defaultSettings = {
        contrast: false,
        triage: true,
        triageCollapsed: false,
        hidePast: true,
        pinWeek: true,
        hideLocked: false,
        course: 'All',
        status: 'incomplete',
        timeframe: 'this_week',
        sort: 'date_asc',
        clinicalSchedules: {} // keyed by course id: { startDate: 'YYYY-MM-DD' }
    };

    let userSettings = JSON.parse(localStorage.getItem('tm_canvas_settings')) || { ...defaultSettings };
    for (const key in defaultSettings) {
        if (!(key in userSettings)) userSettings[key] = defaultSettings[key];
    }

    function saveSettings() {
        localStorage.setItem('tm_canvas_settings', JSON.stringify(userSettings));
    }

    let globalTasks = [];
    const courseColors = ['#e74c3c', '#8e44ad', '#2980b9', '#27ae60', '#d35400', '#16a085', '#2c3e50'];
    const courseColorMap = {};

    function getCleanId(url) {
        if (!url || url === '#') return 'unknown_id_' + Math.random();
        return url.split('?')[0].replace(/\/$/, "");
    }

    function getCompletedTasks() {
        return JSON.parse(localStorage.getItem('tm_canvas_completed_tasks') || '[]');
    }

    function toggleTaskCompletion(cleanId) {
        let tasks = getCompletedTasks();
        if (tasks.includes(cleanId)) tasks = tasks.filter(id => id !== cleanId);
        else tasks.push(cleanId);
        localStorage.setItem('tm_canvas_completed_tasks', JSON.stringify(tasks));
    }

    async function fetchGlobalAssignments() {
        // Fetch a window that includes the recent past too, so items that
        // were due before today (but are still worth showing in Overdue /
        // Done / history) are part of globalTasks.
        const past = new Date();
        past.setDate(past.getDate() - 60);
        const startStr = past.toISOString();
        const future = new Date();
        future.setDate(future.getDate() + 120);
        const endStr = future.toISOString();

        // Try paginating to collect all items in the window. Be defensive:
        // if any page fails (Canvas can 404 on out-of-range pages instead of
        // returning an empty array), KEEP whatever we already collected
        // rather than throwing the whole result away.
        let items = [];
        try {
            let page = 1;
            while (true) {
                let response;
                try {
                    response = await fetch(`/api/v1/planner/items?start_date=${startStr}&end_date=${endStr}&per_page=100&page=${page}`);
                } catch (netErr) {
                    console.warn("[Ky's Canvas] planner page", page, "network error", netErr);
                    break;
                }
                if (!response.ok) {
                    // 404 / 401 on a later page just means "no more data"
                    if (page === 1) {
                        console.error("[Ky's Canvas] planner page 1 failed:", response.status);
                    }
                    break;
                }
                let batch;
                try { batch = await response.json(); }
                catch (e) { console.warn("[Ky's Canvas] planner JSON parse error", e); break; }
                if (!Array.isArray(batch) || batch.length === 0) break;
                items = items.concat(batch);
                if (batch.length < 100) break;
                page++;
                if (page > 10) break; // safety
            }
        } catch (error) {
            console.error("[Ky's Canvas] planner fetch error:", error);
        }

        let virtualClinicals = [];
        try { virtualClinicals = await fetchClinicalVirtualItems(); }
        catch (e) { console.warn("[Ky's Canvas] clinical virtuals failed", e); }

        return [...items, ...virtualClinicals];
    }

    // Returns cached list of active courses, fetched lazily.
    let _coursesCache = null;
    async function getActiveCourses() {
        if (_coursesCache) return _coursesCache;
        try {
            const r = await fetch('/api/v1/courses?enrollment_state=active&per_page=50');
            if (!r.ok) throw new Error('courses fetch failed');
            _coursesCache = await r.json();
            return _coursesCache;
        } catch (e) {
            console.warn("[Ky's Canvas] courses fetch failed", e);
            return [];
        }
    }

    // For each clinical course the user has scheduled, pull undated assignments
    // and assign virtual dates evenly across 21 days starting at the user-provided
    // start date. Two modes:
    //   1) "Clinical Day N" pattern matches — preferred (we know the day order).
    //      Duplicates by day number are deduped (Canvas sometimes returns the same
    //      Clinical Day N quiz under two assignment IDs).
    //   2) Fallback: if no "Clinical Day N" items exist, use ALL undated
    //      assignments in the course (keeps stable order via assignment ID).
    //      This covers courses like Psych Clinical where work is named differently
    //      (Typhon Time Logs, Video Case Studies, etc.).
    async function fetchClinicalVirtualItems() {
        const schedules = userSettings.clinicalSchedules || {};
        if (!Object.keys(schedules).length) return [];
        const courses = await getActiveCourses();

        const results = [];
        for (const course of courses) {
            const sched = schedules[course.id];
            if (!sched || !sched.startDate) continue;

            let assignments;
            try {
                const r = await fetch(`/api/v1/courses/${course.id}/assignments?per_page=100`);
                if (!r.ok) continue;
                assignments = await r.json();
            } catch (_) { continue; }

            // First pass: try "Clinical Day N" pattern matches
            const clinicalDaysMap = new Map(); // dayNum -> assignment (dedupe)
            assignments.forEach(a => {
                if (a.due_at) return;
                const m = (a.name || '').match(/clinical\s*day\s*(\d+)/i);
                if (!m) return;
                const dayNum = parseInt(m[1], 10);
                // Dedupe: prefer the assignment with the lower ID (the original)
                const existing = clinicalDaysMap.get(dayNum);
                if (!existing || a.id < existing.id) {
                    clinicalDaysMap.set(dayNum, a);
                }
            });

            let scheduled = []; // [{label, assignment}]

            if (clinicalDaysMap.size) {
                // Mode 1: "Clinical Day N" — preferred
                const sortedDays = [...clinicalDaysMap.keys()].sort((a, b) => a - b);
                scheduled = sortedDays.map(dayNum => ({
                    assignment: clinicalDaysMap.get(dayNum)
                }));
            } else {
                // Mode 2 (fallback): no "Clinical Day N" items — use ALL undated
                // assignments for this course, in stable assignment-ID order.
                scheduled = assignments
                    .filter(a => !a.due_at)
                    .sort((x, y) => x.id - y.id)
                    .map(a => ({ assignment: a }));
            }

            if (!scheduled.length) continue;

            // Spread across a 21-day window starting at startDate
            const start = new Date(sched.startDate + 'T12:00:00');
            const count = scheduled.length;
            const spanDays = 20; // 21-day window = 0..20

            scheduled.forEach((cd, idx) => {
                const offset = count === 1 ? 0 : Math.round((idx * spanDays) / (count - 1));
                const virtualDate = new Date(start);
                virtualDate.setDate(virtualDate.getDate() + offset);

                results.push({
                    // Shape like a planner item so downstream code works unchanged
                    plannable_type: 'assignment',
                    plannable_date: virtualDate.toISOString(),
                    plannable: {
                        title: cd.assignment.name + '  (estimated)',
                        points_possible: cd.assignment.points_possible
                    },
                    html_url: cd.assignment.html_url,
                    context_name: course.name,
                    _virtual_clinical: true
                });
            });
        }
        return results;
    }

    // Returns {start, end} Date window for filtering given a timeframe value.
    // Supported values: 'today', 'tomorrow', 'this_week', 'next_week', numbers, 999.
    function getTimeframeWindow(tf) {
        const now = new Date();
        const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);

        if (tf === 'today') {
            const end = new Date(startOfToday); end.setHours(23, 59, 59, 999);
            return { start: null, end };
        }
        if (tf === 'tomorrow') {
            const start = new Date(startOfToday); start.setDate(start.getDate() + 1);
            const end = new Date(start); end.setHours(23, 59, 59, 999);
            return { start, end };
        }
        if (tf === 'this_week') {
            // Through this Sunday 23:59 (Sunday = end of week)
            const end = new Date(now);
            const day = end.getDay(); // 0=Sun .. 6=Sat
            const daysUntilSunday = day === 0 ? 0 : 7 - day;
            end.setDate(end.getDate() + daysUntilSunday);
            end.setHours(23, 59, 59, 999);
            return { start: null, end };
        }
        if (tf === 'next_week') {
            const day = now.getDay();
            const daysUntilNextMon = day === 0 ? 1 : (8 - day);
            const start = new Date(startOfToday);
            start.setDate(start.getDate() + daysUntilNextMon);
            const end = new Date(start);
            end.setDate(end.getDate() + 6);
            end.setHours(23, 59, 59, 999);
            return { start, end };
        }
        if (typeof tf === 'number' || /^\d+$/.test(tf)) {
            const n = parseInt(tf, 10);
            if (n === 999) return { start: null, end: null };
            const end = new Date(now);
            end.setDate(end.getDate() + n);
            end.setHours(23, 59, 59, 999);
            return { start: null, end };
        }
        return { start: null, end: null };
    }

    // ==========================================
    // 2. DRAGGABLE UI UTILITY
    // ==========================================

    function makeDraggable(el, handle) {
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        if (handle) {
            handle.onmousedown = dragMouseDown;
            handle.style.cursor = 'grab';
        } else {
            el.onmousedown = dragMouseDown;
            el.style.cursor = 'grab';
        }
        function dragMouseDown(e) {
            e.preventDefault();
            if (['BUTTON', 'INPUT', 'SELECT', 'OPTION'].includes(e.target.tagName)) return;
            pos3 = e.clientX;
            pos4 = e.clientY;
            document.onmouseup = closeDragElement;
            document.onmousemove = elementDrag;
            if (handle) handle.style.cursor = 'grabbing';

            const style = window.getComputedStyle(el);
            if (style.transform !== 'none') {
                const rect = el.getBoundingClientRect();
                el.style.transform = 'none';
                el.style.left = rect.left + 'px';
                el.style.top = rect.top + 'px';
                el.style.right = 'auto';
                el.style.bottom = 'auto';
                el.style.margin = '0';
            }
        }
        function elementDrag(e) {
            e.preventDefault();
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;
            el.style.top = (el.offsetTop - pos2) + "px";
            el.style.left = (el.offsetLeft - pos1) + "px";
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        }
        function closeDragElement() {
            document.onmouseup = null;
            document.onmousemove = null;
            if (handle) handle.style.cursor = 'grab';
        }
    }

    function bindSegmentedControl(containerId, settingKey, callback, isInt = false) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.querySelectorAll('.tm-seg-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                container.querySelectorAll('.tm-seg-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                let val = e.target.getAttribute('data-val');
                // If the value is purely digits, store as integer; otherwise keep as string
                if (isInt || /^\d+$/.test(val)) val = parseInt(val);
                userSettings[settingKey] = val;
                saveSettings();
                if (callback) callback();
            });
        });
    }

    // ==========================================
    // 3. MODAL RENDERING & FILTERING
    // ==========================================

    function initGlobalModal(items) {
        globalTasks = items.filter(item => item.plannable_type !== 'planner_note' && item.plannable_date);

        let colorIndex = 0;
        globalTasks.forEach(t => {
            // FIX: don't split on "-" (breaks "Med-Surg"). Keep the full context name so
            // "Med-Surg I" and "Med-Surg I | Clinical" stay distinct, and allow more chars
            // so "| Clinical" survives truncation.
            let cleanName = (t.context_name || 'Unknown Course').trim().substring(0, 30);
            t.clean_course_name = cleanName;
            t.clean_id = getCleanId(t.html_url);
            if (!courseColorMap[cleanName]) {
                courseColorMap[cleanName] = courseColors[colorIndex % courseColors.length];
                colorIndex++;
            }
        });

        let overlay = document.getElementById('tm-global-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'tm-global-overlay';
            document.body.appendChild(overlay);
        }

        const courses = [...new Set(globalTasks.map(t => t.clean_course_name))].sort();

        let courseTabsHtml = `<button class="tm-tab-btn ${userSettings.course === 'All' ? 'active' : ''}" data-course="All">All Classes</button>`;
        courses.forEach(c => {
            courseTabsHtml += `<button class="tm-tab-btn ${userSettings.course === c ? 'active' : ''}" data-course="${c}">${c}</button>`;
        });

        overlay.innerHTML = `
            <div id="tm-global-modal">
                <div id="tm-modal-header" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid rgba(0,0,0,0.05); padding: 18px 22px; background: linear-gradient(135deg, #f8f9fa 0%, #fff 100%);">
                    <h2 style="margin: 0; color: #0055a5; font-size: 22px; font-weight: 700; pointer-events: none;">🌐 Ky's Canvas</h2>
                    <button id="tm-close-global" style="background: #e74c3c; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 14px; transition: 0.2s; font-family: inherit;">Close ✖</button>
                </div>

                <div class="tm-modal-filters">
                    <div class="tm-filter-section-label">Filter by Course</div>
                    <div id="tm-course-tabs">
                        ${courseTabsHtml}
                    </div>

                    <div class="tm-filter-bar">
                        <span id="tm-task-count">Showing 0 tasks</span>
                        <div class="tm-filter-controls">
                            <div class="tm-filter-group">
                                <label>Status</label>
                                <div class="tm-segmented-control" id="tm-status-ctrl">
                                    <button class="tm-seg-btn ${userSettings.status === 'complete' ? 'active' : ''}" data-val="complete">Done</button>
                                    <button class="tm-seg-btn ${userSettings.status === 'all' ? 'active' : ''}" data-val="all">All</button>
                                    <button class="tm-seg-btn ${userSettings.status === 'incomplete' ? 'active' : ''}" data-val="incomplete">To Do</button>
                                    <button class="tm-seg-btn ${userSettings.status === 'overdue' ? 'active' : ''}" data-val="overdue">Overdue</button>
                                </div>
                            </div>
                            <div class="tm-filter-group">
                                <label>Timeframe</label>
                                <div class="tm-segmented-control" id="tm-timeframe-ctrl">
                                    <button class="tm-seg-btn ${userSettings.timeframe === 'today' ? 'active' : ''}" data-val="today">Today</button>
                                    <button class="tm-seg-btn ${userSettings.timeframe === 'tomorrow' ? 'active' : ''}" data-val="tomorrow">Tmrw</button>
                                    <button class="tm-seg-btn ${userSettings.timeframe === 'this_week' ? 'active' : ''}" data-val="this_week">Wk</button>
                                    <button class="tm-seg-btn ${userSettings.timeframe === 'next_week' ? 'active' : ''}" data-val="next_week">Nxt Wk</button>
                                    <button class="tm-seg-btn ${userSettings.timeframe === 14 ? 'active' : ''}" data-val="14">14D</button>
                                    <button class="tm-seg-btn ${userSettings.timeframe === 30 ? 'active' : ''}" data-val="30">1M</button>
                                    <button class="tm-seg-btn ${userSettings.timeframe === 999 ? 'active' : ''}" data-val="999">All</button>
                                </div>
                            </div>
                            <div class="tm-filter-group">
                                <label>Sort</label>
                                <div class="tm-segmented-control" id="tm-sort-ctrl">
                                    <button class="tm-seg-btn ${userSettings.sort === 'date_asc' ? 'active' : ''}" data-val="date_asc">Soonest</button>
                                    <button class="tm-seg-btn ${userSettings.sort === 'date_desc' ? 'active' : ''}" data-val="date_desc">Furthest</button>
                                    <button class="tm-seg-btn ${userSettings.sort === 'course' ? 'active' : ''}" data-val="course">Course</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div id="tm-global-task-list">
                    <ul id="tm-task-ul"></ul>
                </div>
            </div>
        `;

        overlay.style.display = 'block';
        makeDraggable(document.getElementById('tm-global-modal'), document.getElementById('tm-modal-header'));
        document.getElementById('tm-close-global').addEventListener('click', () => { overlay.style.display = 'none'; });

        document.querySelectorAll('.tm-tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.tm-tab-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                userSettings.course = e.target.getAttribute('data-course');
                saveSettings();
                renderTaskList();
            });
        });

        bindSegmentedControl('tm-status-ctrl', 'status', renderTaskList);
        bindSegmentedControl('tm-timeframe-ctrl', 'timeframe', renderTaskList);
        bindSegmentedControl('tm-sort-ctrl', 'sort', renderTaskList);

        document.getElementById('tm-task-ul').addEventListener('change', (e) => {
            if (e.target.classList.contains('tm-chk-complete')) {
                const li = e.target.closest('li');
                if (e.target.checked) li.classList.add('tm-completed-item');
                else li.classList.remove('tm-completed-item');
                toggleTaskCompletion(e.target.getAttribute('data-id'));
                setTimeout(() => { renderTaskList(); }, 400);
            }
        });

        renderTaskList();
    }

    function renderTaskList() {
        const listUl = document.getElementById('tm-task-ul');
        let filteredTasks = [...globalTasks];
        const completedIds = getCompletedTasks();
        const now = new Date();

        // Status filter
        if (userSettings.status === 'incomplete') {
            filteredTasks = filteredTasks.filter(t => !completedIds.includes(t.clean_id));
        } else if (userSettings.status === 'complete') {
            filteredTasks = filteredTasks.filter(t => completedIds.includes(t.clean_id));
        } else if (userSettings.status === 'overdue') {
            filteredTasks = filteredTasks.filter(t => !completedIds.includes(t.clean_id) && new Date(t.plannable_date) < now);
        }

        // When viewing completed tasks, ignore the timeframe / course filters.
        // Rationale: you may mark a task done that was due last week or in a
        // different course — you still want to see it in your "Done" history.
        if (userSettings.status !== 'complete') {
            // Timeframe window (Sunday-anchored for 'this_week' / 'next_week')
            const { start: tfStart, end: tfEnd } = getTimeframeWindow(userSettings.timeframe);
            if (tfStart || tfEnd) {
                filteredTasks = filteredTasks.filter(t => {
                    const d = new Date(t.plannable_date);
                    if (tfStart && d < tfStart) return false;
                    if (tfEnd && d > tfEnd) return false;
                    return true;
                });
            }

            if (userSettings.course !== 'All') filteredTasks = filteredTasks.filter(t => t.clean_course_name === userSettings.course);
        }

        filteredTasks.sort((a, b) => {
            if (userSettings.sort === 'date_asc') return new Date(a.plannable_date) - new Date(b.plannable_date);
            if (userSettings.sort === 'date_desc') return new Date(b.plannable_date) - new Date(a.plannable_date);
            if (userSettings.sort === 'course') return a.clean_course_name.localeCompare(b.clean_course_name) || (new Date(a.plannable_date) - new Date(b.plannable_date));
            return 0;
        });

        // Summary strip: count, total pts, quiz count
        const totalPts = filteredTasks.reduce((s, t) => s + (parseFloat(t.plannable.points_possible) || 0), 0);
        const quizCount = filteredTasks.filter(t => t.plannable_type === 'quiz').length;
        const parts = [`${filteredTasks.length} task${filteredTasks.length === 1 ? '' : 's'}`];
        if (totalPts > 0) parts.push(`${totalPts % 1 === 0 ? totalPts : totalPts.toFixed(1)} pts`);
        if (quizCount > 0) parts.push(`${quizCount} quiz${quizCount === 1 ? '' : 'zes'}`);
        document.getElementById('tm-task-count').innerText = parts.join(' • ');

        const groupByDay = userSettings.sort === 'date_asc' || userSettings.sort === 'date_desc';
        const todayKey = now.toDateString();
        const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowKey = tomorrow.toDateString();

        let html = '';
        if (filteredTasks.length === 0) {
            html = `<li class="tm-empty-state">No assignments match these filters.</li>`;
        } else {
            let lastDateKey = '';
            filteredTasks.forEach(task => {
                const title = task.plannable.title;
                const courseName = task.clean_course_name;
                const link = task.html_url;
                const points = task.plannable.points_possible !== null ? task.plannable.points_possible : '0';
                const dueDate = new Date(task.plannable_date);
                const dateKey = dueDate.toDateString();

                // Insert day header when date changes (only for date sorts)
                if (groupByDay && dateKey !== lastDateKey) {
                    let headerLabel = dueDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
                    if (dateKey === todayKey) headerLabel = 'Today · ' + headerLabel;
                    else if (dateKey === tomorrowKey) headerLabel = 'Tomorrow · ' + headerLabel;
                    html += `<li class="tm-date-header">${headerLabel}</li>`;
                    lastDateKey = dateKey;
                }

                const dateStr = dueDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

                // Urgency class for date chip
                const hoursUntil = (dueDate - now) / 36e5;
                let urgencyClass = '';
                if (hoursUntil < 0) urgencyClass = 'tm-meta-date-overdue';
                else if (hoursUntil < 24) urgencyClass = 'tm-meta-date-today';
                else if (hoursUntil < 48) urgencyClass = 'tm-meta-date-soon';

                let icon = '📝';
                if (task.plannable_type === 'quiz') icon = '🧠';
                if (title.toLowerCase().includes('discussion')) icon = '💬';
                if (task._virtual_clinical) icon = '🩺';
                const courseColor = courseColorMap[courseName];
                const isCompleted = completedIds.includes(task.clean_id);
                const completedClass = isCompleted ? 'tm-completed-item' : '';
                const virtualClass = task._virtual_clinical ? 'tm-virtual-clinical' : '';

                html += `
                    <li class="tm-task-row ${completedClass} ${virtualClass}" style="border-left-color: ${courseColor};">
                        <div class="tm-task-left">
                            <input type="checkbox" class="tm-chk-complete" data-id="${task.clean_id}" ${isCompleted ? 'checked' : ''}>
                            <div class="tm-task-info">
                                <span class="tm-course-badge" style="background: ${courseColor}18; color: ${courseColor};">${courseName}</span>
                                <div class="tm-task-title-row">
                                    <span class="tm-task-icon">${icon}</span>
                                    <a href="${link}" class="tm-task-link" target="_blank">${title}</a>
                                </div>
                            </div>
                        </div>
                        <div class="tm-task-meta">
                            <span class="tm-meta-date ${urgencyClass}">📅 ${dateStr}</span>
                            <span class="tm-meta-pts">⭐ ${points} pts</span>
                        </div>
                    </li>
                `;
            });
        }
        listUl.innerHTML = html;
    }

    // ==========================================
    // 4. LOCAL MODULE FUNCTIONS
    // ==========================================

    const week1StartDate = new Date('2026-02-09T00:00:00');

    function isModulesPage() { return window.location.pathname.includes('/modules'); }

    function getCurrentWeekNumber() {
        const now = new Date();
        const start = new Date(week1StartDate.getFullYear(), week1StartDate.getMonth(), week1StartDate.getDate());
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const diffDays = Math.floor((today - start) / (1000 * 60 * 60 * 24));
        return Math.floor(diffDays / 7) + 1 > 0 ? Math.floor(diffDays / 7) + 1 : 1;
    }

    function isPastDate(dateStr) {
        if (!dateStr || dateStr === 'No Date') return false;
        const now = new Date();
        const itemDate = new Date(`${dateStr} ${now.getFullYear()}`);
        if (isNaN(itemDate)) return false;
        now.setHours(0, 0, 0, 0);
        itemDate.setHours(0, 0, 0, 0);
        return itemDate < now;
    }

    function pinCurrentWeek() {
        if (!isModulesPage() || !userSettings.pinWeek) return;
        const currentWeekNum = getCurrentWeekNumber();
        const targetText = (`0${currentWeekNum}`).slice(-2);
        const modules = document.querySelectorAll('.item-group-condensed');
        const container = document.getElementById('context_modules') || document.querySelector('.ig-list');
        if (!container) return;
        let modulePinned = false;
        modules.forEach(mod => {
            const titleEl = mod.querySelector('.ig-header-title, .name, .module-title');
            if (titleEl && (titleEl.innerText.includes(`Week ${targetText}`) || titleEl.innerText.includes(`Week ${currentWeekNum}`))) {
                container.prepend(mod);
                modulePinned = true;
                mod.style.border = '2px solid #0770A3';
                mod.style.boxShadow = '0 2px 8px rgba(7,112,163,0.15)';
                mod.style.backgroundColor = '#f5fbff';
                mod.style.borderRadius = '6px';
            }
        });
        if (modulePinned) setTimeout(() => { window.scrollTo({ top: 0, behavior: 'smooth' }); }, 100);
    }

    function toggleLockedModules() {
        if (!isModulesPage()) return;
        document.querySelectorAll('.item-group-condensed').forEach(mod => {
            if (mod.classList.contains('locked_module') || mod.innerHTML.includes('Module Locked') || mod.innerHTML.includes('Will unlock')) {
                mod.style.display = userSettings.hideLocked ? 'none' : '';
            }
        });
    }

    function buildLocalTriageDashboard() {
        if (!isModulesPage()) return;
        let dashboard = document.getElementById('tm-triage-dashboard');

        if (!userSettings.triage) {
            if (dashboard) dashboard.style.display = 'none';
            return;
        }

        const completedIds = getCompletedTasks();
        if (!dashboard) {
            dashboard = document.createElement('div');
            dashboard.id = 'tm-triage-dashboard';
            const moduleContainer = document.getElementById('context_modules') || document.querySelector('.ig-list');
            if (moduleContainer && moduleContainer.parentNode) moduleContainer.parentNode.insertBefore(dashboard, moduleContainer);
        } else {
            dashboard.style.display = 'block';
        }

        dashboard.innerHTML = `
            <div class="tm-local-header">
                <div style="display:flex; align-items:center; gap:10px;">
                    <button class="tm-collapse-btn" id="tm-triage-collapse-btn" title="Collapse / expand" aria-label="Collapse">
                        <svg viewBox="0 0 20 20" width="14" height="14"><path d="M5 7l5 6 5-6" stroke="#394B58" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    </button>
                    <h2>Upcoming Items</h2>
                </div>
                <span>Auto-extracted from modules</span>
            </div>
            <div class="tm-collapsible"><ul id="tm-local-triage-list"></ul></div>
        `;

        // Apply persisted collapsed state
        if (userSettings.triageCollapsed) dashboard.classList.add('tm-collapsed');

        // Wire up collapse button
        document.getElementById('tm-triage-collapse-btn').addEventListener('click', () => {
            userSettings.triageCollapsed = !userSettings.triageCollapsed;
            saveSettings();
            dashboard.classList.toggle('tm-collapsed', userSettings.triageCollapsed);
        });

        const list = document.getElementById('tm-local-triage-list');
        let taskCount = 0, hiddenCount = 0;

        document.querySelectorAll('.ig-row, .module-item').forEach(item => {
            const isLocked = item.closest('.item-group-condensed') && (item.closest('.item-group-condensed').innerHTML.includes('Module Locked') || item.closest('.item-group-condensed').innerHTML.includes('Will unlock'));
            const titleEl = item.querySelector('.ig-title, .title, a');
            if (!titleEl) return;

            const title = titleEl.innerText.trim();
            const href = titleEl.href || '#';
            const cleanId = getCleanId(href);
            const isCompleted = completedIds.includes(cleanId);
            const dateMatch = item.innerText.trim().match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s\d{1,2}/i);
            const ptsMatch = item.innerText.trim().match(/\d+(\.\d+)?\spts/i);

            if (dateMatch || ptsMatch) {
                const dateText = dateMatch ? dateMatch[0] : 'No Date';
                const ptsText = ptsMatch ? ptsMatch[0] : 'Ungraded';

                if ((userSettings.hidePast && isPastDate(dateText)) || isCompleted) { hiddenCount++; return; }

                taskCount++;
                let icon = '📝';
                if (title.toLowerCase().includes('quiz') || title.toLowerCase().includes('test')) icon = '🧠';

                const li = document.createElement('li');
                li.className = 'tm-local-item';
                li.style.opacity = isLocked ? '0.5' : '1';
                li.style.borderLeftColor = ptsText === 'Ungraded' ? '#D1D5DB' : '#0770A3';

                li.innerHTML = `
                    <div class="tm-task-left">
                        <input type="checkbox" class="tm-local-chk-complete" data-id="${cleanId}">
                        <span class="tm-task-icon">${icon}</span>
                        <a href="${href}" class="tm-task-link">${title} ${isLocked ? '🔒' : ''}</a>
                    </div>
                    <div class="tm-task-meta">
                        <span class="tm-meta-date">📅 ${dateText}</span>
                        <span class="tm-meta-pts">⭐ ${ptsText}</span>
                    </div>`;
                list.appendChild(li);
            }
        });

        if (taskCount === 0) list.innerHTML = '<li class="tm-empty-state">No upcoming items found.</li>';
        else if (hiddenCount > 0) list.innerHTML += `<li class="tm-hidden-count">${hiddenCount} completed or past-due item(s) hidden</li>`;

        list.addEventListener('change', (e) => {
            if (e.target.classList.contains('tm-local-chk-complete')) {
                const li = e.target.closest('li');
                li.classList.add('tm-completed-item');
                toggleTaskCompletion(e.target.getAttribute('data-id'));
                setTimeout(() => { buildLocalTriageDashboard(); }, 400);
            }
        });
    }

    // ==========================================
    // 5. STYLES — Canvas-Native Look
    // ==========================================

    addStyle(`
        /* ==========================================
           DARK MODE — targets real Canvas elements
           ========================================== */
        .tm-dark-mode,
        .tm-dark-mode #wrapper,
        .tm-dark-mode #main,
        .tm-dark-mode #content,
        .tm-dark-mode #content-wrapper,
        .tm-dark-mode .ic-Layout-contentMain,
        .tm-dark-mode .ic-Layout-contentWrapper,
        .tm-dark-mode .ic-Layout-wrapper {
            background-color: #1a1a2e !important;
            color: #e0e0e0 !important;
        }
        .tm-dark-mode #left-side,
        .tm-dark-mode .ic-app-course-menu,
        .tm-dark-mode nav[aria-label="Courses Navigation Menu"],
        .tm-dark-mode #section-tabs,
        .tm-dark-mode #course_menu,
        .tm-dark-mode .course-menu {
            background-color: #16213e !important;
        }
        .tm-dark-mode #section-tabs a,
        .tm-dark-mode .section a {
            color: #90CAF9 !important;
        }
        .tm-dark-mode #section-tabs a.active,
        .tm-dark-mode #section-tabs a:hover {
            color: #fff !important;
            background-color: rgba(255,255,255,0.08) !important;
        }
        .tm-dark-mode .item-group-condensed {
            background-color: #1e2a3a !important;
            border-color: #2a3a4e !important;
        }
        .tm-dark-mode .ig-header {
            background-color: #243447 !important;
            border-color: #2a3a4e !important;
        }
        .tm-dark-mode .ig-header-title,
        .tm-dark-mode .ig-header .name {
            color: #e0e0e0 !important;
        }
        .tm-dark-mode .ig-row,
        .tm-dark-mode .ig-list .ig-row {
            background-color: #1e2a3a !important;
            border-color: #2a3a4e !important;
        }
        .tm-dark-mode .ig-row a,
        .tm-dark-mode .ig-title a,
        .tm-dark-mode .ig-info a {
            color: #90CAF9 !important;
        }
        .tm-dark-mode .ig-details,
        .tm-dark-mode .ig-info .due_date_display,
        .tm-dark-mode .ig-info .points_possible_display,
        .tm-dark-mode .ig-info .type_icon,
        .tm-dark-mode .module-item-status-icon,
        .tm-dark-mode .points_possible_display,
        .tm-dark-mode .due_date_display {
            color: #9e9e9e !important;
        }
        .tm-dark-mode .header-bar,
        .tm-dark-mode .header-bar-right {
            background-color: transparent !important;
        }
        .tm-dark-mode .btn {
            background-color: #2a3a4e !important;
            color: #e0e0e0 !important;
            border-color: #3a4e63 !important;
        }
        .tm-dark-mode .ic-app-nav-toggle-and-crumbs {
            background-color: #16213e !important;
            border-color: #2a3a4e !important;
        }
        .tm-dark-mode #breadcrumbs a,
        .tm-dark-mode #breadcrumbs .ellipsible {
            color: #90CAF9 !important;
        }
        .tm-dark-mode #section-tabs-header,
        .tm-dark-mode #section-tabs-header-subtitle {
            color: #bbb !important;
        }
        .tm-dark-mode .context_module .ig-header-admin .completion_status .icon-check {
            color: #66BB6A !important;
        }
        .tm-dark-mode #tm-triage-dashboard {
            background-color: #1e2a3a !important;
            border-color: #2a3a4e !important;
        }
        .tm-dark-mode #tm-triage-dashboard h2 { color: #90CAF9 !important; }
        .tm-dark-mode .tm-local-item { background-color: #243447 !important; border-color: #2a3a4e !important; }
        .tm-dark-mode .tm-local-item .tm-task-link { color: #90CAF9 !important; }
        .tm-dark-mode .tm-meta-date { background: #3d2a1a !important; }
        .tm-dark-mode .tm-meta-pts { background: #1a3d2a !important; }

        /* ==========================================
           TRIAGE BUTTON — injected into header-bar
           ========================================== */
        #tm-triage-btn {
            display: inline-flex; align-items: center; justify-content: center;
            padding: 6px 10px; border-radius: 4px; border: 1px solid #C7CDD1;
            background: #fff; color: #2D3B45; font-size: 14px;
            font-family: 'LatoWeb', 'Lato', 'Helvetica Neue', Helvetica, Arial, sans-serif;
            cursor: pointer; transition: background 0.15s; line-height: 1;
            height: 33px; vertical-align: middle;
        }
        #tm-triage-btn:hover { background: #F5F5F5; }
        #tm-triage-btn svg { width: 20px; height: 20px; }
        .tm-dark-mode #tm-triage-btn { background: #2a3a4e; color: #e0e0e0; border-color: #3a4e63; }
        .tm-dark-mode #tm-triage-btn:hover { background: #3a4e63; }
        .tm-dark-mode #tm-triage-btn svg { fill: #e0e0e0; }

        /* ==========================================
           SETTINGS GEAR (FAB)
           ========================================== */
        #tm-canvas-icon {
            display: flex; align-items: center; justify-content: center;
            position: fixed; bottom: 24px; right: 24px; width: 44px; height: 44px;
            background: #394B58; color: white; border-radius: 50%;
            cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.18); z-index: 999999;
            user-select: none; transition: transform 0.15s, background 0.15s; border: none;
        }
        #tm-canvas-icon:hover { background: #2D3B45; transform: scale(1.08); }

        /* ==========================================
           SETTINGS PANEL
           ========================================== */
        #tm-canvas-widget {
            display: none; position: fixed; bottom: 78px; right: 24px; width: 270px;
            background: #fff; border: 1px solid #C7CDD1; border-radius: 8px; padding: 0;
            box-shadow: 0 4px 20px rgba(0,0,0,0.12); z-index: 999999;
            font-family: 'LatoWeb', 'Lato', 'Helvetica Neue', Helvetica, Arial, sans-serif;
            color: #2D3B45; overflow: hidden;
        }
        .tm-dark-mode #tm-canvas-widget {
            background: #1e2a3a; border-color: #2a3a4e; color: #e0e0e0;
        }
        #tm-widget-header {
            font-size: 13px; font-weight: 700; padding: 12px 16px;
            border-bottom: 1px solid #E8EAED; margin: 0;
            display: flex; align-items: center; gap: 8px; color: #394B58;
        }
        .tm-dark-mode #tm-widget-header { border-color: #2a3a4e; color: #e0e0e0; }
        .tm-dark-mode #tm-widget-header svg { fill: #e0e0e0; }
        .tm-widget-body { padding: 12px 16px 8px; }

        /* ---- Toggle Switch ---- */
        .tm-toggle-row {
            margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between;
            padding: 3px 0;
        }
        .tm-toggle-row label { cursor: pointer; font-size: 13px; user-select: none; color: #2D3B45; }
        .tm-dark-mode .tm-toggle-row label { color: #e0e0e0; }
        .tm-toggle-switch { position: relative; display: inline-block; width: 36px; height: 20px; flex-shrink: 0; }
        .tm-toggle-switch input { opacity: 0; width: 0; height: 0; }
        .tm-toggle-switch .tm-slider {
            position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0;
            background-color: #C7CDD1; transition: 0.2s; border-radius: 20px;
        }
        .tm-toggle-switch .tm-slider:before {
            position: absolute; content: ""; height: 14px; width: 14px; left: 3px; bottom: 3px;
            background-color: white; transition: 0.2s; border-radius: 50%;
            box-shadow: 0 1px 2px rgba(0,0,0,0.12);
        }
        .tm-toggle-switch input:checked + .tm-slider { background-color: #0770A3; }
        .tm-toggle-switch input:checked + .tm-slider:before { transform: translateX(16px); }

        .tm-section-label {
            font-size: 10px; font-weight: 700; color: #6B7B8D; text-transform: uppercase;
            letter-spacing: 0.5px; margin: 10px 0 6px 0; padding-top: 8px;
            border-top: 1px solid #E8EAED;
        }
        .tm-dark-mode .tm-section-label { color: #8899aa; border-color: #2a3a4e; }

        .tm-indent { padding-left: 14px; border-left: 2px solid #E8EAED; margin-left: 4px; }
        .tm-dark-mode .tm-indent { border-color: #2a3a4e; }

        #tm-close-widget {
            width: 100%; padding: 10px; margin: 0; background: transparent;
            color: #6B7B8D; border: none; border-top: 1px solid #E8EAED;
            cursor: pointer; font-size: 12px; font-weight: 600; transition: 0.15s;
            font-family: inherit;
        }
        #tm-close-widget:hover { background: #F5F5F5; color: #2D3B45; }
        .tm-dark-mode #tm-close-widget { border-color: #2a3a4e; color: #8899aa; }
        .tm-dark-mode #tm-close-widget:hover { background: #243447; color: #e0e0e0; }

        /* ==========================================
           MODAL OVERLAY
           ========================================== */
        #tm-global-overlay {
            display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(45,59,69,0.4); z-index: 9999999;
            backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
        }
        #tm-global-modal {
            position: absolute; top: 8vh; left: 50%; transform: translateX(-50%);
            background: rgba(250, 250, 250, 0.97); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
            width: 950px; max-width: 95vw; border-radius: 16px;
            box-shadow: 0 15px 40px rgba(0,0,0,0.2);
            font-family: 'LatoWeb', 'Lato', 'Helvetica Neue', Helvetica, Arial, sans-serif;
            border: 1px solid rgba(255,255,255,0.5); overflow: hidden;
        }
        #tm-modal-header {
            display: flex; justify-content: space-between; align-items: center;
            padding: 18px 22px;
        }
        #tm-close-global:hover { background: #c0392b; }

        .tm-modal-filters { padding: 14px 20px; border-bottom: 1px solid #E8EAED; }
        .tm-filter-section-label {
            font-size: 10px; font-weight: 700; color: #6B7B8D;
            text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;
        }

        #tm-course-tabs { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 10px; }

        .tm-tab-btn {
            background: rgba(255,255,255,0.8); border: 1px solid rgba(0,0,0,0.1); padding: 6px 14px;
            border-radius: 20px; cursor: pointer; font-size: 13px; font-weight: bold;
            color: #2c3e50; white-space: nowrap; transition: all 0.2s;
            box-shadow: 0 1px 3px rgba(0,0,0,0.05); font-family: inherit;
        }
        .tm-tab-btn:hover { background: #f0f3f4; }
        .tm-tab-btn.active {
            background: #0055a5; color: #fff; border-color: #0055a5;
            box-shadow: inset 0 2px 4px rgba(0,0,0,0.2);
        }

        .tm-filter-bar {
            display: flex; justify-content: space-between; align-items: flex-end;
            margin-top: 8px; padding-top: 12px; border-top: 1px solid #E8EAED;
        }
        #tm-task-count { font-size: 13px; font-weight: 600; color: #394B58; }
        .tm-filter-controls { display: flex; gap: 14px; }

        .tm-filter-group { display: flex; flex-direction: column; gap: 3px; }
        .tm-filter-group > label {
            font-size: 10px; font-weight: 700; color: #6B7B8D;
            text-transform: uppercase; letter-spacing: 0.4px; padding-left: 2px;
        }
        .tm-segmented-control {
            display: flex; background: #E8EAED; border-radius: 6px; padding: 2px;
        }
        .tm-seg-btn {
            background: transparent; border: none; padding: 4px 9px; border-radius: 4px;
            cursor: pointer; font-size: 11px; font-weight: 600; color: #6B7B8D;
            transition: all 0.15s; outline: none; font-family: inherit;
        }
        .tm-seg-btn:hover { color: #394B58; }
        .tm-seg-btn.active {
            background: #fff; color: #0770A3; box-shadow: 0 1px 3px rgba(0,0,0,0.08); font-weight: 700;
        }

        /* ---- Task List ---- */
        #tm-global-task-list { max-height: 55vh; overflow-y: auto; padding: 8px 0; }
        #tm-task-ul { list-style: none; padding: 0; margin: 0; }

        .tm-task-row {
            padding: 12px 20px; display: flex; justify-content: space-between; align-items: center;
            border-bottom: 1px solid #f0f0f0; border-left: 5px solid #ccc;
            transition: all 0.2s; background: rgba(255,255,255,0.8);
            margin: 0 12px 8px 12px; border-radius: 6px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.04);
        }
        .tm-task-row:hover { background: #fff; box-shadow: 0 3px 8px rgba(0,0,0,0.08); }
        .tm-task-left { display: flex; align-items: center; flex: 1; gap: 12px; padding-right: 16px; }
        .tm-task-left input[type="checkbox"] { width: 17px; height: 17px; cursor: pointer; accent-color: #0770A3; flex-shrink: 0; }
        .tm-task-info { display: flex; flex-direction: column; gap: 3px; }
        .tm-course-badge {
            font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px;
            padding: 1px 7px; border-radius: 10px; width: fit-content;
        }
        .tm-task-title-row { display: flex; align-items: center; gap: 6px; }
        .tm-task-icon { font-size: 15px; flex-shrink: 0; }
        .tm-task-link {
            color: #0770A3; font-weight: 600; text-decoration: none; font-size: 13px; line-height: 1.3;
        }
        .tm-task-link:hover { text-decoration: underline; }
        .tm-task-meta { display: flex; flex-direction: column; gap: 4px; min-width: 120px; align-items: flex-end; }
        .tm-meta-date {
            font-size: 11px; font-weight: bold; color: #d35400; background: #fdf2e9;
            padding: 3px 8px; border-radius: 4px; white-space: nowrap;
        }
        .tm-meta-pts {
            font-size: 11px; font-weight: bold; color: #27ae60; background: #eafaf1;
            padding: 3px 8px; border-radius: 4px; white-space: nowrap;
        }

        .tm-completed-item { opacity: 0.3 !important; }
        .tm-completed-item .tm-task-link { text-decoration: line-through !important; color: #999 !important; }

        .tm-empty-state { padding: 30px 20px; text-align: center; color: #6B7B8D; font-size: 14px; list-style: none; }
        .tm-hidden-count {
            padding: 8px 20px; text-align: center; font-size: 12px; color: #999; font-style: italic;
            border: none; list-style: none;
        }

        /* ---- Scrollbar ---- */
        #tm-global-task-list::-webkit-scrollbar { width: 6px; }
        #tm-global-task-list::-webkit-scrollbar-track { background: transparent; }
        #tm-global-task-list::-webkit-scrollbar-thumb { background: #C7CDD1; border-radius: 3px; }

        /* ---- Local Triage Dashboard ---- */
        #tm-triage-dashboard {
            background: #fff; border: 1px solid #C7CDD1; border-radius: 6px;
            padding: 16px 20px; margin-bottom: 16px;
        }
        .tm-dark-mode #tm-triage-dashboard .tm-local-header span { color: #8899aa !important; }
        .tm-local-header {
            display: flex; justify-content: space-between; align-items: center;
            border-bottom: 1px solid #E8EAED; padding-bottom: 10px; margin-bottom: 12px;
        }
        .tm-local-header h2 { margin: 0; font-size: 16px; color: #394B58; font-weight: 700; }
        .tm-local-header span { font-size: 12px; color: #6B7B8D; }
        #tm-local-triage-list { list-style: none; padding: 0; margin: 0; }
        .tm-local-item {
            padding: 10px 12px; border-bottom: 1px solid #F0F0F0; display: flex;
            justify-content: space-between; align-items: center;
            border-left: 3px solid #0770A3; margin-bottom: 4px; border-radius: 4px;
            background: #FAFBFC; transition: background 0.1s;
        }
        .tm-local-item:hover { background: #F0F7FC; }
        .tm-local-item .tm-task-left { gap: 10px; }
        .tm-local-item .tm-task-left input[type="checkbox"] { width: 16px; height: 16px; }
        .tm-local-item .tm-task-link { font-size: 13px; color: #0770A3; }

        /* ==========================================
           v3.6 — Day headers, urgency, collapse, clinical, update banner
           ========================================== */
        .tm-date-header {
            list-style: none; margin: 14px 12px 4px 12px; padding: 6px 12px;
            font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px;
            color: #394B58; background: #E8EAED; border-radius: 4px;
            position: sticky; top: 0; z-index: 1;
        }
        .tm-dark-mode .tm-date-header { background: #243447; color: #cfd8e2; }

        .tm-meta-date-overdue { background: #fadbd8 !important; color: #c0392b !important; }
        .tm-meta-date-today   { background: #fdebd0 !important; color: #b9770e !important; }
        .tm-meta-date-soon    { background: #fef5e7 !important; color: #d35400 !important; }

        .tm-virtual-clinical { border-left-style: dashed !important; }
        .tm-virtual-clinical .tm-task-link::after {
            content: " · est."; font-size: 10px; color: #9AA5B1; font-weight: 500;
        }

        /* Collapse on triage dashboard */
        .tm-collapse-btn {
            background: transparent; border: none; padding: 4px; cursor: pointer;
            display: inline-flex; align-items: center; justify-content: center;
            border-radius: 4px; transition: background 0.15s, transform 0.2s;
        }
        .tm-collapse-btn:hover { background: #F0F3F4; }
        .tm-dark-mode .tm-collapse-btn:hover { background: #2a3a4e; }
        .tm-dark-mode .tm-collapse-btn svg path { stroke: #cfd8e2; }
        #tm-triage-dashboard.tm-collapsed .tm-collapse-btn { transform: rotate(-90deg); }
        #tm-triage-dashboard.tm-collapsed .tm-collapsible { display: none; }
        #tm-triage-dashboard.tm-collapsed .tm-local-header { border-bottom: none; padding-bottom: 0; margin-bottom: 0; }

        /* Clinical schedule section in settings panel */
        .tm-clinical-row {
            display: flex; flex-direction: column; gap: 4px; padding: 6px 0;
        }
        .tm-clinical-row > label {
            font-size: 12px; color: #2D3B45; line-height: 1.3;
        }
        .tm-dark-mode .tm-clinical-row > label { color: #e0e0e0; }
        .tm-clinical-row input[type="date"] {
            font-family: inherit; font-size: 12px;
            padding: 4px 6px; border: 1px solid #C7CDD1; border-radius: 4px;
            background: #fff; color: #2D3B45; width: 100%;
        }
        .tm-dark-mode .tm-clinical-row input[type="date"] {
            background: #243447; color: #e0e0e0; border-color: #3a4e63;
        }
        .tm-clinical-empty {
            font-size: 11px; color: #6B7B8D; font-style: italic; padding: 4px 0;
        }

        /* In-page update toast */
        #tm-update-toast {
            position: fixed; bottom: 80px; right: 24px;
            background: linear-gradient(135deg, #0770A3 0%, #0a8fcf 100%);
            color: white; padding: 12px 16px; border-radius: 8px;
            box-shadow: 0 4px 16px rgba(0,0,0,0.2); z-index: 999998;
            font-family: 'LatoWeb', 'Lato', 'Helvetica Neue', Helvetica, Arial, sans-serif;
            font-size: 13px; max-width: 280px; display: none;
        }
        #tm-update-toast.tm-show { display: block; }
        #tm-update-toast strong { display: block; margin-bottom: 4px; }
        #tm-update-toast a {
            color: #fff; text-decoration: underline; font-weight: 600;
        }
        #tm-update-toast .tm-toast-close {
            position: absolute; top: 4px; right: 8px;
            background: transparent; border: none; color: white; cursor: pointer;
            font-size: 16px; line-height: 1;
        }
    `);

    // ==========================================
    // 6. WIDGET CREATION & INITIALIZATION
    // ==========================================

    function makeToggleHTML(id, label, checked, indent) {
        const cls = indent ? 'tm-toggle-row tm-indent' : 'tm-toggle-row';
        return `
            <div class="${cls}">
                <label for="${id}">${label}</label>
                <label class="tm-toggle-switch">
                    <input type="checkbox" id="${id}" ${checked ? 'checked' : ''}>
                    <span class="tm-slider"></span>
                </label>
            </div>
        `;
    }

    async function populateClinicalSchedules() {
        const section = document.getElementById('tm-clinical-section');
        const body = document.getElementById('tm-clinical-body');
        if (!section || !body) return;

        const courses = await getActiveCourses();
        const clinicalCourses = courses.filter(c => /clinical/i.test(c.name || ''));
        if (!clinicalCourses.length) {
            section.style.display = 'none';
            return;
        }
        section.style.display = 'block';

        let html = '';
        clinicalCourses.forEach(c => {
            const sched = (userSettings.clinicalSchedules || {})[c.id] || {};
            const shortName = (c.name || '').trim().substring(0, 28);
            html += `
                <div class="tm-clinical-row">
                    <label for="tm-clin-${c.id}">${shortName}</label>
                    <input type="date" id="tm-clin-${c.id}" data-course-id="${c.id}" value="${sched.startDate || ''}">
                </div>
            `;
        });
        if (!html) html = '<div class="tm-clinical-empty">No clinical courses detected.</div>';
        body.innerHTML = html;

        // Bind inputs
        body.querySelectorAll('input[type="date"]').forEach(input => {
            input.addEventListener('change', (e) => {
                const courseId = e.target.getAttribute('data-course-id');
                if (!userSettings.clinicalSchedules) userSettings.clinicalSchedules = {};
                if (e.target.value) {
                    userSettings.clinicalSchedules[courseId] = { startDate: e.target.value };
                } else {
                    delete userSettings.clinicalSchedules[courseId];
                }
                saveSettings();
            });
        });
    }

    // Show toast if the background service worker has flagged an update
    async function checkAndShowUpdateToast() {
        try {
            const { updateInfo } = await api.storage.local.get({ updateInfo: null });
            if (!updateInfo || !updateInfo.hasUpdate) return;
            // Don't show if user already dismissed this version
            const dismissed = localStorage.getItem('tm_canvas_dismissed_update');
            if (dismissed === updateInfo.latestVersion) return;

            const toast = document.createElement('div');
            toast.id = 'tm-update-toast';
            toast.className = 'tm-show';
            toast.innerHTML = `
                <button class="tm-toast-close" aria-label="Dismiss">&times;</button>
                <strong>🚀 Ky's Canvas v${updateInfo.latestVersion}</strong>
                Newer version available${updateInfo.notes ? '. ' + String(updateInfo.notes).substring(0, 60) : ''}.<br>
                ${updateInfo.url ? `<a href="${updateInfo.url}" target="_blank">Install</a>` : ''}
            `;
            document.body.appendChild(toast);

            toast.querySelector('.tm-toast-close').addEventListener('click', () => {
                localStorage.setItem('tm_canvas_dismissed_update', updateInfo.latestVersion);
                toast.remove();
            });
        } catch (e) {
            // no-op
        }
    }

    function createWidget() {
        if (document.getElementById('tm-canvas-widget')) return;

        // --- Triage Button: inject into Canvas header-bar next to Collapse All ---
        const headerBarBtns = document.querySelector('.header-bar-right__buttons');
        if (headerBarBtns) {
            const triageBtn = document.createElement('button');
            triageBtn.id = 'tm-triage-btn';
            triageBtn.title = 'Assignment Triage';
            triageBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="#2D3B45" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C12 2 4.5 9.5 4.5 15c0 2.5 1.5 4.5 3.5 5.5L9 22h6l1-1.5c2-1 3.5-3 3.5-5.5C19.5 9.5 12 2 12 2zm0 4c1.5 2.5 4.5 7 4.5 9 0 1.5-.7 2.8-1.8 3.5H9.3C8.2 17.8 7.5 16.5 7.5 15c0-2 3-6.5 4.5-9z"/><circle cx="12" cy="14" r="2"/></svg>`;
            headerBarBtns.insertBefore(triageBtn, headerBarBtns.firstChild);

            triageBtn.addEventListener('click', async () => {
                triageBtn.disabled = true;
                triageBtn.style.opacity = '0.5';
                const data = await fetchGlobalAssignments();
                initGlobalModal(data);
                triageBtn.disabled = false;
                triageBtn.style.opacity = '1';
            });
        } else {
            // Fallback for non-module pages: floating icon button
            const floatBtn = document.createElement('button');
            floatBtn.id = 'tm-triage-btn';
            floatBtn.title = 'Assignment Triage';
            floatBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="#2D3B45" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C12 2 4.5 9.5 4.5 15c0 2.5 1.5 4.5 3.5 5.5L9 22h6l1-1.5c2-1 3.5-3 3.5-5.5C19.5 9.5 12 2 12 2zm0 4c1.5 2.5 4.5 7 4.5 9 0 1.5-.7 2.8-1.8 3.5H9.3C8.2 17.8 7.5 16.5 7.5 15c0-2 3-6.5 4.5-9z"/><circle cx="12" cy="14" r="2"/></svg>`;
            floatBtn.style.cssText = 'position:fixed; top:14px; left:50%; transform:translateX(-50%); z-index:999999;';
            document.body.appendChild(floatBtn);

            floatBtn.addEventListener('click', async () => {
                floatBtn.disabled = true;
                floatBtn.style.opacity = '0.5';
                const data = await fetchGlobalAssignments();
                initGlobalModal(data);
                floatBtn.disabled = false;
                floatBtn.style.opacity = '1';
            });
        }

        // --- Settings Gear FAB ---
        const icon = document.createElement('div');
        icon.id = 'tm-canvas-icon';
        icon.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1112 8.4a3.6 3.6 0 010 7.2z"/></svg>`;
        icon.title = "Enhancer Settings";
        document.body.appendChild(icon);

        // --- Settings Panel ---
        const widget = document.createElement('div');
        widget.id = 'tm-canvas-widget';

        const moduleSettingsHTML = isModulesPage() ? `
            <div class="tm-section-label">Module Settings</div>
            ${makeToggleHTML('tm-chk-triage', 'Local Triage Panel', userSettings.triage)}
            ${makeToggleHTML('tm-chk-hide-past', 'Hide Past Due', userSettings.hidePast, true)}
            ${makeToggleHTML('tm-chk-pin', 'Pin Current Week', userSettings.pinWeek)}
            ${makeToggleHTML('tm-chk-locked', 'Hide Locked Modules', userSettings.hideLocked)}
        ` : `<div style="padding: 6px 0; font-size: 12px; color: #6B7B8D; text-align: center; font-style: italic;">Navigate to Modules for more settings</div>`;

        widget.innerHTML = `
            <div id="tm-widget-header">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="#394B58" xmlns="http://www.w3.org/2000/svg"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1112 8.4a3.6 3.6 0 010 7.2z"/></svg>
                Settings
            </div>
            <div class="tm-widget-body">
                ${makeToggleHTML('tm-chk-contrast', 'Dark Mode', userSettings.contrast)}
                ${moduleSettingsHTML}
                <div id="tm-clinical-section" style="display:none;">
                    <div class="tm-section-label">Clinical Schedules</div>
                    <div id="tm-clinical-body"></div>
                </div>
            </div>
            <button id="tm-close-widget">Close</button>
        `;
        document.body.appendChild(widget);

        // Populate clinical schedules from course list (async)
        populateClinicalSchedules();

        // Toggle settings panel
        icon.addEventListener('click', () => {
            const showing = widget.style.display === 'block';
            widget.style.display = showing ? 'none' : 'block';
        });
        document.getElementById('tm-close-widget').addEventListener('click', () => { widget.style.display = 'none'; });

        // Init dark mode if saved
        if (userSettings.contrast) document.body.classList.add('tm-dark-mode');

        // Bind toggles
        const bindCheck = (id, key, callback) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', (e) => {
                userSettings[key] = e.target.checked;
                saveSettings();
                if (callback) callback();
            });
        };

        bindCheck('tm-chk-contrast', 'contrast', () => {
            if (userSettings.contrast) document.body.classList.add('tm-dark-mode');
            else document.body.classList.remove('tm-dark-mode');
        });

        if (isModulesPage()) {
            bindCheck('tm-chk-triage', 'triage', () => {
                const hidePastBox = document.getElementById('tm-chk-hide-past');
                if (hidePastBox) hidePastBox.disabled = !userSettings.triage;
                buildLocalTriageDashboard();
            });
            bindCheck('tm-chk-hide-past', 'hidePast', buildLocalTriageDashboard);
            bindCheck('tm-chk-pin', 'pinWeek', () => location.reload());
            bindCheck('tm-chk-locked', 'hideLocked', toggleLockedModules);
        }
    }

    // --- Initialization ---
    setTimeout(() => {
        createWidget();
        if (isModulesPage()) {
            buildLocalTriageDashboard();
            pinCurrentWeek();
            toggleLockedModules();
        }
        checkAndShowUpdateToast();
    }, 1500);

})();
