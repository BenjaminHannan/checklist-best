import React, { useCallback, useEffect, useMemo, useState } from "react";

type Recurrence = "none" | "daily" | "weekly";

type Task = {
  id: string;
  title: string;
  due_date: string;
  recurrence: Recurrence;
  recurrence_detail: string;
  category: string;
  completed: boolean;
  completed_at: string;
  created_at: string;
  updated_at: string;
  archived: boolean;
  rowIndex?: number;
};

type Settings = {
  timezone: string;
  heatmap_window_days: number;
  upcoming_window_days: number;
};

type HeatmapStatus = "none" | "green" | "yellow" | "red";

type DailyStat = {
  date: string;
  dueCount: number;
  completedCount: number;
  status: HeatmapStatus;
};

type GoogleTokenClient = {
  requestAccessToken: (options?: { prompt?: "" | "consent" | "none" }) => void;
};

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: { access_token?: string; error?: string }) => void;
          }) => GoogleTokenClient;
        };
      };
    };
  }
}

const REQUIRED_TASK_HEADERS = [
  "id",
  "title",
  "due_date",
  "recurrence",
  "recurrence_detail",
  "category",
  "completed",
  "completed_at",
  "created_at",
  "updated_at",
  "archived",
];

const SETTINGS_DEFAULTS: Settings = {
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  heatmap_window_days: 120,
  upcoming_window_days: 7,
};

const SETTINGS_KEYS = [
  "timezone",
  "heatmap_window_days",
  "upcoming_window_days",
];

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
].join(" ");

const VIEW_OPTIONS = ["Today", "Upcoming", "All", "Completed"] as const;

const quickDateOptions = [
  { label: "Today", offset: 0 },
  { label: "Tomorrow", offset: 1 },
  { label: "+3d", offset: 3 },
];

const toLocalDateString = (date: Date) => {
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
};

const parseDate = (value: string) => new Date(`${value}T00:00:00`);

const addDays = (value: string, days: number) => {
  const date = parseDate(value);
  date.setDate(date.getDate() + days);
  return toLocalDateString(date);
};

const getWeekday = (value: string) => parseDate(value).getDay().toString();

const getToday = () => toLocalDateString(new Date());

const isBefore = (dateA: string, dateB: string) => parseDate(dateA) < parseDate(dateB);
const isAfter = (dateA: string, dateB: string) => parseDate(dateA) > parseDate(dateB);

const classNames = (...names: Array<string | false | null | undefined>) =>
  names.filter(Boolean).join(" ");

const generateId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `task-${Math.random().toString(36).slice(2)}`;

const normalizeBoolean = (value: string | boolean | undefined) => {
  if (typeof value === "boolean") return value;
  return value?.toString().toLowerCase() === "true";
};

const normalizeTask = (row: string[], headers: string[], rowIndex: number): Task => {
  const record = Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]));
  return {
    id: record.id || generateId(),
    title: record.title || "",
    due_date: record.due_date || getToday(),
    recurrence: (record.recurrence as Recurrence) || "none",
    recurrence_detail: record.recurrence_detail || "",
    category: record.category || "",
    completed: normalizeBoolean(record.completed),
    completed_at: record.completed_at || "",
    created_at: record.created_at || "",
    updated_at: record.updated_at || "",
    archived: normalizeBoolean(record.archived),
    rowIndex,
  };
};

const getNextDueDate = (task: Task) => {
  if (task.recurrence === "daily") return addDays(task.due_date, 1);
  if (task.recurrence === "weekly") return addDays(task.due_date, 7);
  return task.due_date;
};

const buildTaskRow = (task: Task) => [
  task.id,
  task.title,
  task.due_date,
  task.recurrence,
  task.recurrence_detail,
  task.category,
  task.completed ? "TRUE" : "FALSE",
  task.completed_at,
  task.created_at,
  task.updated_at,
  task.archived ? "TRUE" : "FALSE",
];

const initSettingsFromValues = (values: string[][]) => {
  const settings = { ...SETTINGS_DEFAULTS };
  values.forEach(([key, value]) => {
    if (!key) return;
    if (key === "heatmap_window_days" || key === "upcoming_window_days") {
      settings[key] = Number(value) || settings[key];
      return;
    }
    settings[key as keyof Settings] = value as never;
  });
  return settings;
};

const ensureScriptLoaded = (src: string) =>
  new Promise<void>((resolve, reject) => {
    if (document.querySelector(`script[src=\"${src}\"]`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load script"));
    document.body.appendChild(script);
  });

const App: React.FC = () => {
  const [token, setToken] = useState<string | null>(null);
  const [tokenClient, setTokenClient] = useState<GoogleTokenClient | null>(null);
  const [spreadsheetId, setSpreadsheetId] = useState<string>(
    localStorage.getItem("greenday_spreadsheet_id") || "",
  );
  const [status, setStatus] = useState<string>("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [settings, setSettings] = useState<Settings>(SETTINGS_DEFAULTS);
  const [view, setView] = useState<(typeof VIEW_OPTIONS)[number]>("Today");
  const [categoryFilter, setCategoryFilter] = useState<string>("All");

  const [quickTitle, setQuickTitle] = useState("");
  const [quickDueDate, setQuickDueDate] = useState(getToday());
  const [quickRecurrence, setQuickRecurrence] = useState<Recurrence>("none");
  const [quickCategory, setQuickCategory] = useState("");

  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

  useEffect(() => {
    ensureScriptLoaded("https://accounts.google.com/gsi/client")
      .then(() => {
        if (!googleClientId) {
          setStatus("Missing VITE_GOOGLE_CLIENT_ID in .env");
          return;
        }
        if (!window.google?.accounts?.oauth2) return;
        const client = window.google.accounts.oauth2.initTokenClient({
          client_id: googleClientId || "",
          scope: GOOGLE_SCOPES,
          callback: (response) => {
            if (response.error) {
              setStatus(`Auth error: ${response.error}`);
              return;
            }
            if (response.access_token) {
              setToken(response.access_token);
              setStatus("Signed in.");
            }
          },
        });
        setTokenClient(client);
      })
      .catch(() => setStatus("Failed to load Google Identity Services."));
  }, [googleClientId]);

  const apiFetch = useCallback(
    async (url: string, options: RequestInit = {}) => {
      if (!token) throw new Error("Missing access token");
      const response = await fetch(url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...(options.headers || {}),
        },
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `Request failed: ${response.status}`);
      }
      return response.json();
    },
    [token],
  );

  const ensureSpreadsheet = useCallback(
    async (targetId: string) => {
      if (!targetId) return;
      setStatus("Checking spreadsheet structure...");
      const spreadsheet = await apiFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${targetId}?fields=sheets.properties.title`,
      );
      const sheetTitles = new Set<string>(
        spreadsheet.sheets?.map((sheet: { properties: { title: string } }) => sheet.properties.title) || [],
      );
      const requests = [] as Array<Record<string, unknown>>;

      if (!sheetTitles.has("Tasks")) {
        requests.push({
          addSheet: { properties: { title: "Tasks" } },
        });
      }
      if (!sheetTitles.has("Settings")) {
        requests.push({
          addSheet: { properties: { title: "Settings" } },
        });
      }

      if (requests.length > 0) {
        await apiFetch(`https://sheets.googleapis.com/v4/spreadsheets/${targetId}:batchUpdate`, {
          method: "POST",
          body: JSON.stringify({ requests }),
        });
      }

      await apiFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${targetId}/values/Tasks!A1:K1`,
      ).then(async (result) => {
        const existing = (result.values?.[0] as string[]) || [];
        if (existing.join("|") !== REQUIRED_TASK_HEADERS.join("|")) {
          await apiFetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${targetId}/values/Tasks!A1:K1?valueInputOption=RAW`,
            {
              method: "PUT",
              body: JSON.stringify({ values: [REQUIRED_TASK_HEADERS] }),
            },
          );
        }
      });

      await apiFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${targetId}/values/Settings!A1:B${
          SETTINGS_KEYS.length + 1
        }`,
      ).then(async (result) => {
        const rows = result.values || [];
        if (!rows.length || rows[0][0] !== "key") {
          const values = [
            ["key", "value"],
            ...SETTINGS_KEYS.map((key) => [key, `${SETTINGS_DEFAULTS[key as keyof Settings]}`]),
          ];
          await apiFetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${targetId}/values/Settings!A1:B${
              SETTINGS_KEYS.length + 1
            }?valueInputOption=RAW`,
            {
              method: "PUT",
              body: JSON.stringify({ values }),
            },
          );
        }
      });

      setStatus("Spreadsheet ready.");
    },
    [apiFetch],
  );

  const loadSettings = useCallback(
    async (targetId: string) => {
      const settingsResponse = await apiFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${targetId}/values/Settings!A2:B`,
      );
      const loaded = initSettingsFromValues(settingsResponse.values || []);
      setSettings(loaded);
    },
    [apiFetch],
  );

  const loadTasks = useCallback(
    async (targetId: string) => {
      const taskResponse = await apiFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${targetId}/values/Tasks!A1:K`,
      );
      const [headersRow, ...rows] = (taskResponse.values || []) as string[][];
      if (!headersRow) {
        setTasks([]);
        return;
      }
      const tasksParsed = rows.map((row, index) => normalizeTask(row, headersRow, index + 2));
      setTasks(tasksParsed);
    },
    [apiFetch],
  );

  const refreshData = useCallback(async () => {
    if (!spreadsheetId) return;
    await ensureSpreadsheet(spreadsheetId);
    await Promise.all([loadTasks(spreadsheetId), loadSettings(spreadsheetId)]);
  }, [ensureSpreadsheet, loadSettings, loadTasks, spreadsheetId]);

  useEffect(() => {
    if (token && spreadsheetId) {
      refreshData().catch((error) => setStatus(`Failed to load data: ${error.message}`));
    }
  }, [token, spreadsheetId, refreshData]);

  const handleSignIn = () => {
    if (!googleClientId) {
      setStatus("Missing VITE_GOOGLE_CLIENT_ID in .env");
      return;
    }
    tokenClient?.requestAccessToken({ prompt: "consent" });
  };

  const handleConnectSheet = async () => {
    try {
      if (!spreadsheetId) return;
      localStorage.setItem("greenday_spreadsheet_id", spreadsheetId);
      await refreshData();
    } catch (error) {
      if (error instanceof Error) {
        setStatus(`Failed to connect: ${error.message}`);
      }
    }
  };

  const handleCreateTemplate = async () => {
    if (!token) return;
    try {
      setStatus("Creating template...");
      const payload = {
        properties: { title: "GreenDay Checklist" },
        sheets: [
          { properties: { title: "Tasks" } },
          { properties: { title: "Settings" } },
        ],
      };
      const response = await apiFetch("https://sheets.googleapis.com/v4/spreadsheets", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const newId = response.spreadsheetId as string;
      setSpreadsheetId(newId);
      localStorage.setItem("greenday_spreadsheet_id", newId);
      await ensureSpreadsheet(newId);
      await refreshData();
      setStatus("Template created and connected.");
    } catch (error) {
      if (error instanceof Error) {
        setStatus(`Template failed: ${error.message}`);
      }
    }
  };

  const handleAddTask = async () => {
    if (!spreadsheetId) return;
    if (!quickTitle.trim()) {
      setStatus("Title required.");
      return;
    }
    const now = new Date().toISOString();
    const newTask: Task = {
      id: generateId(),
      title: quickTitle.trim(),
      due_date: quickDueDate,
      recurrence: quickRecurrence,
      recurrence_detail: quickRecurrence === "weekly" ? getWeekday(quickDueDate) : "",
      category: quickCategory.trim(),
      completed: false,
      completed_at: "",
      created_at: now,
      updated_at: now,
      archived: false,
    };
    try {
      await apiFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Tasks!A1:K1:append?valueInputOption=RAW`,
        {
          method: "POST",
          body: JSON.stringify({ values: [buildTaskRow(newTask)] }),
        },
      );
      setQuickTitle("");
      setQuickRecurrence("none");
      setQuickCategory("");
      setStatus("Task added.");
      await refreshData();
    } catch (error) {
      if (error instanceof Error) {
        setStatus(`Add task failed: ${error.message}`);
      }
    }
  };

  const updateTaskRow = async (task: Task) => {
    if (!task.rowIndex || !spreadsheetId) return;
    await apiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Tasks!A${task.rowIndex}:K${task.rowIndex}?valueInputOption=RAW`,
      {
        method: "PUT",
        body: JSON.stringify({ values: [buildTaskRow(task)] }),
      },
    );
  };

  const appendTask = async (task: Task) => {
    if (!spreadsheetId) return;
    await apiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Tasks!A1:K1:append?valueInputOption=RAW`,
      {
        method: "POST",
        body: JSON.stringify({ values: [buildTaskRow(task)] }),
      },
    );
  };

  const handleToggleComplete = async (task: Task) => {
    const now = new Date().toISOString();
    const completed = !task.completed;
    const updatedTask = {
      ...task,
      completed,
      completed_at: completed ? now : "",
      updated_at: now,
    };
    try {
      await updateTaskRow(updatedTask);
      setTasks((prev) => prev.map((item) => (item.id === task.id ? updatedTask : item)));
      if (completed && task.recurrence !== "none") {
        const nextTask: Task = {
          ...task,
          id: generateId(),
          due_date: getNextDueDate(task),
          completed: false,
          completed_at: "",
          created_at: now,
          updated_at: now,
          archived: false,
          rowIndex: undefined,
        };
        await appendTask(nextTask);
        await refreshData();
      }
    } catch (error) {
      if (error instanceof Error) {
        setStatus(`Update failed: ${error.message}`);
      }
    }
  };

  const handleArchive = async (task: Task) => {
    const now = new Date().toISOString();
    const updatedTask = { ...task, archived: !task.archived, updated_at: now };
    try {
      await updateTaskRow(updatedTask);
      setTasks((prev) => prev.map((item) => (item.id === task.id ? updatedTask : item)));
    } catch (error) {
      if (error instanceof Error) {
        setStatus(`Archive failed: ${error.message}`);
      }
    }
  };

  const handleEditTask = async (task: Task, updates: Partial<Task>) => {
    const now = new Date().toISOString();
    const updatedTask = { ...task, ...updates, updated_at: now };
    try {
      await updateTaskRow(updatedTask);
      setTasks((prev) => prev.map((item) => (item.id === task.id ? updatedTask : item)));
    } catch (error) {
      if (error instanceof Error) {
        setStatus(`Edit failed: ${error.message}`);
      }
    }
  };

  const handleDueDateChange = (task: Task, dueDate: string) => {
    const updates: Partial<Task> = { due_date: dueDate };
    if (task.recurrence === "weekly") {
      updates.recurrence_detail = getWeekday(dueDate);
    }
    handleEditTask(task, updates);
  };

  const handleRecurrenceChange = (task: Task, recurrence: Recurrence) => {
    const updates: Partial<Task> = {
      recurrence,
      recurrence_detail: recurrence === "weekly" ? getWeekday(task.due_date) : "",
    };
    handleEditTask(task, updates);
  };

  const categories = useMemo(() => {
    const unique = new Set(tasks.map((task) => task.category).filter(Boolean));
    return ["All", ...Array.from(unique).sort()];
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    const today = getToday();
    const upcomingLimit = addDays(today, settings.upcoming_window_days);

    const baseTasks = tasks.filter((task) => !task.archived);
    const withCategory =
      categoryFilter === "All" ? baseTasks : baseTasks.filter((task) => task.category === categoryFilter);

    switch (view) {
      case "Today":
        return withCategory.filter(
          (task) => task.due_date === today || isBefore(task.due_date, today),
        );
      case "Upcoming":
        return withCategory.filter(
          (task) => task.due_date >= today && task.due_date <= upcomingLimit,
        );
      case "Completed":
        return withCategory.filter((task) => task.completed);
      case "All":
      default:
        return withCategory;
    }
  }, [tasks, view, categoryFilter, settings.upcoming_window_days]);

  const heatmapData = useMemo(() => {
    const today = getToday();
    const days = settings.heatmap_window_days;
    const stats: DailyStat[] = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const date = addDays(today, -i);
      const dueTasks = tasks.filter(
        (task) => task.due_date === date && !task.archived,
      );
      const completedCount = dueTasks.filter((task) => task.completed).length;
      const dueCount = dueTasks.length;
      let status: HeatmapStatus = "none";
      if (dueCount > 0) {
        status = completedCount === dueCount ? "green" : completedCount === 0 ? "red" : "yellow";
      }
      stats.push({ date, dueCount, completedCount, status });
    }
    return stats;
  }, [tasks, settings.heatmap_window_days]);

  const streakCount = useMemo(() => {
    const today = getToday();
    let count = 0;
    for (let i = 0; i < heatmapData.length; i += 1) {
      const dateToCheck = addDays(today, -i);
      const stat = heatmapData.find((entry) => entry.date === dateToCheck);
      if (!stat || stat.status !== "green") break;
      count += 1;
    }
    return count;
  }, [heatmapData]);

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>GreenDay Checklist</h1>
          <p className="subtitle">Make every day green. Plan fast, finish faster.</p>
        </div>
        <div className="auth-block">
          {token ? (
            <span className="status">Connected</span>
          ) : (
            <button className="primary" onClick={handleSignIn}>
              Sign in with Google
            </button>
          )}
          <span className="status-text">{status}</span>
        </div>
      </header>

      <section className="setup">
        <div className="field">
          <label htmlFor="sheet-id">Spreadsheet ID</label>
          <input
            id="sheet-id"
            value={spreadsheetId}
            onChange={(event) => setSpreadsheetId(event.target.value)}
            placeholder="Paste Google Sheet ID"
          />
        </div>
        <div className="setup-actions">
          <button className="primary" onClick={handleConnectSheet} disabled={!token || !spreadsheetId}>
            Connect sheet
          </button>
          <button className="ghost" onClick={handleCreateTemplate} disabled={!token}>
            Create/Copy Template
          </button>
        </div>
      </section>

      <section className="quick-add">
        <input
          placeholder="Quick add task title"
          value={quickTitle}
          onChange={(event) => setQuickTitle(event.target.value)}
        />
        <div className="quick-controls">
          <input
            type="date"
            value={quickDueDate}
            onChange={(event) => setQuickDueDate(event.target.value)}
          />
          <div className="date-buttons">
            {quickDateOptions.map((option) => (
              <button
                key={option.label}
                className="ghost"
                onClick={() => setQuickDueDate(addDays(getToday(), option.offset))}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
          <select
            value={quickRecurrence}
            onChange={(event) => setQuickRecurrence(event.target.value as Recurrence)}
          >
            <option value="none">No recurrence</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
          <input
            placeholder="Category (optional)"
            value={quickCategory}
            onChange={(event) => setQuickCategory(event.target.value)}
          />
          <button className="primary" onClick={handleAddTask}>
            Add task
          </button>
        </div>
      </section>

      <main className="layout">
        <aside className="sidebar">
          <div className="section">
            <h3>Views</h3>
            {VIEW_OPTIONS.map((option) => (
              <button
                key={option}
                className={classNames("nav", option === view && "active")}
                onClick={() => setView(option)}
              >
                {option}
              </button>
            ))}
          </div>
          <div className="section">
            <h3>Categories</h3>
            <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </div>
          <div className="section">
            <h3>Streak</h3>
            <div className="streak">
              <span>{streakCount}</span>
              <p>green days</p>
            </div>
          </div>
        </aside>

        <section className="content">
          <h2>{view} tasks</h2>
          <div className="task-list">
            {filteredTasks.length === 0 ? (
              <div className="empty">No tasks here. Add one to get started.</div>
            ) : (
              filteredTasks.map((task) => {
                const today = getToday();
                const overdue = isBefore(task.due_date, today) && !task.completed;
                const dueToday = task.due_date === today;
                return (
                  <div key={task.id} className={classNames("task", task.completed && "completed")}>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={task.completed}
                        onChange={() => handleToggleComplete(task)}
                      />
                      <span />
                    </label>
                    <div className="task-info">
                      <input
                        className="task-title"
                        value={task.title}
                        onChange={(event) => handleEditTask(task, { title: event.target.value })}
                      />
                      <div className="meta">
                        <span className={classNames("badge", overdue && "overdue", dueToday && "today")}>
                          {overdue ? "Overdue" : dueToday ? "Due today" : `Due ${task.due_date}`}
                        </span>
                        {task.recurrence !== "none" && (
                          <span className="badge">{task.recurrence}</span>
                        )}
                        {task.category && <span className="badge ghost">{task.category}</span>}
                      </div>
                    </div>
                    <div className="task-actions">
                      <input
                        type="date"
                        value={task.due_date}
                        onChange={(event) => handleDueDateChange(task, event.target.value)}
                      />
                      <select
                        value={task.recurrence}
                        onChange={(event) =>
                          handleRecurrenceChange(task, event.target.value as Recurrence)
                        }
                      >
                        <option value="none">None</option>
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                      </select>
                      <button className="ghost" onClick={() => handleArchive(task)}>
                        {task.archived ? "Restore" : "Archive"}
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <aside className="right-panel">
          <h3>Completion heatmap</h3>
          <div className="heatmap">
            {heatmapData.map((stat) => (
              <div
                key={stat.date}
                className={classNames("heat-cell", stat.status)}
                title={`${stat.date}: ${stat.completedCount}/${stat.dueCount} completed`}
              />
            ))}
          </div>
          <div className="legend">
            <span className="heat-cell none" /> No tasks
            <span className="heat-cell red" /> 0% done
            <span className="heat-cell yellow" /> Partial
            <span className="heat-cell green" /> All done
          </div>
        </aside>
      </main>
    </div>
  );
};

export default App;
