interface AndroidResumedActivity {
  token: string;
  user: string;
  component: string;
  task: string;
}

export function androidResumedActivity(output: string): AndroidResumedActivity | undefined {
  // The summary is the top focused activity. The per-task entries can include
  // other resumed activities in split-screen or on secondary displays.
  const summary = [...output.matchAll(/^[ \t]*ResumedActivity: ActivityRecord\{([a-f0-9]+) u(\d+) (\S+) t(\d+)\}[ \t]*\r?$/gm)];
  const records = summary.length ? summary
    : [...output.matchAll(/^[ \t]*topResumedActivity=ActivityRecord\{([a-f0-9]+) u(\d+) (\S+) t(\d+)\}[ \t]*\r?$/gm)];
  if (records.length !== 1) return undefined;
  const [, token, user, component, task] = records[0] ?? [];
  if (!token || !user || !component || !task) return undefined;
  const fullComponent = component.replace(/^([^/]+)\/\./, "$1/$1.");
  return { token, user, component: fullComponent, task };
}
