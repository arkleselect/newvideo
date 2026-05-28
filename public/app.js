const state = {
  files: [],
  activeJobId: null,
  activeJob: null,
  latestJob: null,
  isUploading: false,
  uploadHint: "",
  uploadProgress: 0,
  uploadTotalBytes: 0,
  uploadUploadedBytes: 0,
  encodeProfile: "tight",
  concurrency: 1
};

const uploadInput = document.querySelector("#uploadInput");
const uploadZone = document.querySelector(".upload-zone");
const uploadButton = document.querySelector("#uploadButton");
const submitButton = document.querySelector("#submitButton");
const interruptButton = document.querySelector("#interruptButton");
const refreshButton = document.querySelector("#refreshButton");
const uploadStatus = document.querySelector("#uploadStatus");
const uploadProgressFill = document.querySelector("#uploadProgressFill");
const uploadProgressText = document.querySelector("#uploadProgressText");
const encodeProfileInputs = Array.from(document.querySelectorAll('input[name="encodeProfile"]'));
const concurrencyInputs = Array.from(document.querySelectorAll('input[name="jobConcurrency"]'));
const fileCount = document.querySelector("#fileCount");
const currentFile = document.querySelector("#currentFile");
const deleteUploadsButton = document.querySelector("#deleteUploadsButton");
const deleteCurrentButton = document.querySelector("#deleteCurrentButton");
const jobState = document.querySelector("#jobState");
const progressFill = document.querySelector("#progressFill");
const progressText = document.querySelector("#progressText");
const resultList = document.querySelector("#resultList");
const archiveButton = document.querySelector("#archiveButton");

const supportedExtensions = new Set([".mp4", ".mov", ".mkv", ".avi", ".m4v", ".webm"]);

async function fetchJson(url, options) {
  const nextOptions = { ...(options || {}) };
  nextOptions.headers = options && options.headers ? options.headers : {};
  const response = await fetch(url, nextOptions);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }
  return data;
}

function uploadFileWithProgress(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", "/api/upload");
    xhr.responseType = "json";
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded, event.total);
      }
    };

    xhr.onload = () => {
      const payload = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload);
        return;
      }
      reject(new Error(payload.error || `Upload failed with status ${xhr.status}`));
    };

    xhr.onerror = () => reject(new Error("Upload failed."));
    xhr.send(file);
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isActiveJob(job) {
  return job && (job.status === "queued" || job.status === "running");
}

function renderUploadStatus() {
  const uploadCompleted = !state.isUploading && state.uploadHint.startsWith("上传完成");
  uploadStatus.classList.toggle("upload-complete", uploadCompleted);

  if (state.isUploading) {
    uploadStatus.textContent = state.uploadHint || "正在上传…";
  } else if (state.uploadHint) {
    uploadStatus.textContent = state.uploadHint;
  } else {
    uploadStatus.textContent = "选择多个视频文件后上传。";
  }
  uploadButton.disabled = state.isUploading;
  uploadZone.classList.toggle("drag-active", false);

  const progress = state.isUploading ? state.uploadProgress : 0;
  uploadProgressFill.style.width = `${progress}%`;
  uploadProgressText.textContent = `${progress.toFixed(2)}%`;
}

function renderSummary() {
  fileCount.textContent = String(state.files.length);

  const job = state.activeJob || state.latestJob;
  const currentFiles = state.activeJob?.currentFiles || [];
  currentFile.textContent = currentFiles.length > 1
    ? `${currentFiles[0]} 等 ${currentFiles.length} 个`
    : currentFiles[0] || state.activeJob?.currentFile || "-";

  const statusText = job
    ? `状态: ${job.status} | 阶段: ${job.stage}${job.profileLabel ? ` | 方案: ${job.profileLabel}` : ""}${job.concurrency ? ` | 并行: ${job.concurrency}` : ""}`
    : "等待上传后开始处理。";
  jobState.className = `job-state ${job ? (job.status === "completed" ? "complete" : job.status === "running" ? "active" : "") : "empty"}`.trim();
  jobState.textContent = statusText;

  const progress = job ? job.progress || 0 : 0;
  progressFill.style.width = `${progress}%`;
  progressText.textContent = `${Number(progress).toFixed(2)}%`;

  const canStart = !state.isUploading && state.files.length > 0 && !isActiveJob(job);
  submitButton.disabled = !canStart;
  submitButton.textContent = isActiveJob(job) ? "处理中…" : "开始处理全部";

  const canInterrupt = Boolean(state.activeJob && (state.activeJob.status === "queued" || state.activeJob.status === "running"));
  interruptButton.classList.toggle("hidden", !canInterrupt);
  interruptButton.disabled = !canInterrupt;
  interruptButton.textContent = state.activeJob?.status === "queued" ? "取消排队" : "中断任务";

  const canDeleteUploads = Boolean(state.files.length && !isActiveJob(job));
  deleteUploadsButton.classList.toggle("hidden", !canDeleteUploads);
  deleteUploadsButton.disabled = !canDeleteUploads;

  const canDeleteCurrent = Boolean(
    state.latestJob &&
      state.latestJob.status !== "queued" &&
      state.latestJob.status !== "running" &&
      !state.latestJob.sourceCleared &&
      state.latestJob.files.length
  );
  deleteCurrentButton.classList.toggle("hidden", !canDeleteCurrent);
  deleteCurrentButton.disabled = !canDeleteCurrent;
}

function renderResults(job) {
  if (!job || !job.results.length) {
    resultList.className = "result-list empty";
    resultList.innerHTML = job?.status === "failed" && job.errors?.length
      ? `<div class="error-state">任务失败: ${escapeHtml(job.errors[0])}</div>`
      : job?.status === "canceled"
        ? `<div class="error-state">任务已中断。</div>`
      : "处理完成后，可下载的视频会显示在这里。";
    archiveButton.classList.add("hidden");
    archiveButton.removeAttribute("href");
    return;
  }

  resultList.className = "result-list";
  resultList.innerHTML = job.results
    .map(
      (item) => `
        <article class="result-card">
          <div class="result-meta">
            <strong>${escapeHtml(item.outputName)}</strong>
            <span>来源: ${escapeHtml(item.source)} | ${formatBytes(item.size)}</span>
          </div>
          <div class="result-links">
            <a class="download-link" href="${item.outputPath}" download>下载</a>
            <a class="download-link" href="${item.outputPath}" target="_blank" rel="noreferrer">在线播放</a>
          </div>
        </article>
      `
    )
    .join("");

  if (job.status === "completed" && job.results.length > 0) {
    archiveButton.classList.remove("hidden");
    archiveButton.href = `/api/jobs/${job.id}/archive`;
  } else {
    archiveButton.classList.add("hidden");
    archiveButton.removeAttribute("href");
  }
}

function renderJob(job) {
  state.activeJob = job || null;
  state.activeJobId = job?.id || null;
  state.latestJob = job || null;
  renderSummary();
  renderResults(job);
}

async function refreshFiles() {
  const data = await fetchJson("/api/files");
  state.files = data.files || [];
  renderSummary();
}

async function refreshJobs() {
  const data = await fetchJson("/api/jobs");
  const latestRunning = data.jobs.find((job) => isActiveJob(job)) || null;
  const latest = data.jobs[0] || null;

  state.activeJob = latestRunning;
  state.latestJob = latest;
  state.activeJobId = latestRunning?.id || null;

  renderSummary();
  renderResults(latest);
}

async function uploadFiles(files) {
  const videoFiles = Array.from(files).filter((file) => {
    const ext = `.${file.name.split(".").pop().toLowerCase()}`;
    return supportedExtensions.has(ext);
  });

  if (!videoFiles.length) {
    state.uploadHint = "没有识别到可上传的视频文件。";
    renderUploadStatus();
    return;
  }

  state.isUploading = true;
  state.uploadProgress = 0;
  state.uploadTotalBytes = videoFiles.reduce((sum, file) => sum + file.size, 0);
  state.uploadUploadedBytes = 0;
  state.uploadHint = `正在上传 ${videoFiles.length} 个文件…`;
  renderUploadStatus();

  try {
    for (const [index, file] of videoFiles.entries()) {
      state.uploadHint = `上传 ${index + 1}/${videoFiles.length}: ${file.name}`;
      renderUploadStatus();
      await uploadFileWithProgress(file, (loaded, total) => {
        state.uploadProgress = state.uploadTotalBytes
          ? ((state.uploadUploadedBytes + loaded) / state.uploadTotalBytes) * 100
          : 0;
        state.uploadHint = `上传 ${index + 1}/${videoFiles.length}: ${file.name} (${((loaded / total) * 100).toFixed(2)}%)`;
        renderUploadStatus();
      });
      state.uploadUploadedBytes += file.size;
      state.uploadProgress = state.uploadTotalBytes
        ? (state.uploadUploadedBytes / state.uploadTotalBytes) * 100
        : 0;
    }
    state.uploadHint = "上传完成，点击开始处理全部已上传文件。";
    state.uploadProgress = 100;
    await refreshFiles();
  } catch (error) {
    state.uploadHint = `上传失败: ${error.message}`;
    alert(error.message);
  } finally {
    state.isUploading = false;
    state.uploadProgress = 0;
    state.uploadTotalBytes = 0;
    state.uploadUploadedBytes = 0;
    renderUploadStatus();
    renderSummary();
  }
}

function setDragActive(active) {
  uploadZone.classList.toggle("drag-active", active);
}

function isFileDrag(event) {
  const types = event.dataTransfer ? Array.from(event.dataTransfer.types || []) : [];
  return types.includes("Files");
}

async function startProcessing() {
  submitButton.disabled = true;
  submitButton.textContent = "创建任务中…";

  try {
    const data = await fetchJson("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: state.encodeProfile, concurrency: state.concurrency })
    });
    state.activeJob = data.job;
    state.latestJob = data.job;
    state.activeJobId = data.job.id;
    renderSummary();
    renderResults(data.job);
  } catch (error) {
    alert(error.message);
  } finally {
    renderSummary();
  }
}

async function interruptJob() {
  const job = state.activeJob;
  if (!job) return;

  interruptButton.disabled = true;
  interruptButton.textContent = "中断中…";

  try {
    const data = await fetchJson(`/api/jobs/${job.id}/cancel`, {
      method: "POST"
    });
    state.activeJob = data.job;
    state.latestJob = data.job;
    renderSummary();
    renderResults(data.job);
  } catch (error) {
    alert(error.message);
  } finally {
    renderSummary();
  }
}

uploadButton.addEventListener("click", () => uploadInput.click());
uploadZone.addEventListener("click", (event) => {
  if (event.target.closest("button, a, input")) return;
  uploadInput.click();
});
uploadZone.addEventListener("dragenter", (event) => {
  event.preventDefault();
  if (state.isUploading || !isFileDrag(event)) return;
  setDragActive(true);
});
uploadZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (state.isUploading || !isFileDrag(event)) return;
  event.dataTransfer.dropEffect = "copy";
  setDragActive(true);
});
uploadZone.addEventListener("dragleave", (event) => {
  if (!uploadZone.contains(event.relatedTarget)) {
    setDragActive(false);
  }
});
uploadZone.addEventListener("drop", (event) => {
  event.preventDefault();
  event.stopPropagation();
  setDragActive(false);
  if (state.isUploading || !isFileDrag(event)) return;
  if (event.dataTransfer.files && event.dataTransfer.files.length) {
    uploadFiles(event.dataTransfer.files);
  }
});
uploadInput.addEventListener("change", () => {
  if (uploadInput.files && uploadInput.files.length) {
    uploadFiles(uploadInput.files);
  }
  uploadInput.value = "";
});

encodeProfileInputs.forEach((input) => {
  input.addEventListener("change", () => {
    if (input.checked) {
      state.encodeProfile = input.value;
    }
  });
});

concurrencyInputs.forEach((input) => {
  input.addEventListener("change", () => {
    if (input.checked) {
      state.concurrency = Number(input.value) || 1;
    }
  });
});

document.addEventListener("dragenter", (event) => {
  if (state.isUploading || !isFileDrag(event)) return;
  event.preventDefault();
  setDragActive(true);
});

document.addEventListener("dragover", (event) => {
  if (state.isUploading || !isFileDrag(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  setDragActive(true);
});

document.addEventListener("dragleave", (event) => {
  if (state.isUploading || !isFileDrag(event)) return;
  if (event.relatedTarget && document.contains(event.relatedTarget)) {
    return;
  }
  setDragActive(false);
});

document.addEventListener("drop", (event) => {
  if (state.isUploading || !isFileDrag(event)) return;
  event.preventDefault();
  setDragActive(false);
  if (event.dataTransfer.files && event.dataTransfer.files.length) {
    uploadFiles(event.dataTransfer.files);
  }
});

submitButton.addEventListener("click", (event) => {
  event.preventDefault();
  startProcessing().catch((error) => {
    alert(error.message);
  });
});

interruptButton.addEventListener("click", (event) => {
  event.preventDefault();
  interruptJob().catch((error) => {
    alert(error.message);
  });
});

refreshButton.addEventListener("click", () => {
  Promise.all([refreshFiles(), refreshJobs()]).catch((error) => {
    alert(error.message);
  });
});

deleteUploadsButton.addEventListener("click", async () => {
  if (!confirm("确定删除你自己上传目录里的全部文件吗？")) {
    return;
  }

  try {
    await fetchJson("/api/uploads/clear", {
      method: "POST"
    });
    state.uploadHint = "上传文件已删除。";
    await Promise.all([refreshFiles(), refreshJobs()]);
  } catch (error) {
    alert(error.message);
  }
});

deleteCurrentButton.addEventListener("click", async () => {
  const job = state.latestJob;
  if (!job) return;
  if (!confirm("确定删除这个任务对应的源文件和已完成视频吗？")) {
    return;
  }

  try {
    await fetchJson(`/api/jobs/${job.id}/clear`, {
      method: "POST"
    });
    state.uploadHint = "任务文件已删除。";
    await Promise.all([refreshFiles(), refreshJobs()]);
  } catch (error) {
    alert(error.message);
  }
});

async function boot() {
  renderUploadStatus();
  await Promise.all([refreshFiles(), refreshJobs()]);
  setInterval(() => {
    refreshJobs().catch((error) => {
      console.error(error);
    });
    refreshFiles().catch((error) => {
      console.error(error);
    });
  }, 2000);
}

boot().catch((error) => {
  console.error(error);
  alert(error.message);
});
