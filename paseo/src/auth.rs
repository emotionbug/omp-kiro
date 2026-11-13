use chrono::{DateTime, Utc};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};

// Deliberately not Debug/Serialize: credentials never belong in protocol errors or logs.
pub(crate) struct Credential {
    pub access_token: String,
    pub expires_at: DateTime<Utc>,
    pub profile_arn: Option<String>,
    pub provider: &'static str,
}

pub(crate) fn auth_path(env: &BTreeMap<String, String>) -> Result<PathBuf, ()> {
    auth_path_with_home(env, os_home)
}

fn auth_path_with_home(
    env: &BTreeMap<String, String>,
    home: impl FnOnce() -> Option<PathBuf>,
) -> Result<PathBuf, ()> {
    if let Some(value) = env.get("OMP_KIRO_AUTH_FILE").filter(|v| !v.is_empty()) {
        let path = PathBuf::from(value);
        return path.is_absolute().then_some(path).ok_or(());
    }
    let config = env
        .get("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute());
    let root = match config {
        Some(path) => path,
        None => env
            .get("HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(home)
            .filter(|p| p.is_absolute())
            .ok_or(())?
            .join(".config"),
    };
    Ok(root.join("omp-kiro").join("auth.sqlite3"))
}

#[cfg(unix)]
fn os_home() -> Option<PathBuf> {
    use std::{ffi::CStr, os::unix::ffi::OsStrExt};
    // getpwuid_r, unlike home_dir(), does not consult the process HOME. That
    // distinction prevents a session missing HOME from selecting daemon auth.
    let mut size = 4096;
    loop {
        let mut buffer = vec![0u8; size];
        let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
        let mut result = std::ptr::null_mut();
        let status = unsafe {
            libc::getpwuid_r(
                libc::getuid(),
                entry.as_mut_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };
        if status == libc::ERANGE && size < 1024 * 1024 {
            size *= 2;
            continue;
        }
        if status != 0 || result.is_null() {
            return None;
        }
        let entry = unsafe { entry.assume_init() };
        if entry.pw_dir.is_null() {
            return None;
        }
        let bytes = unsafe { CStr::from_ptr(entry.pw_dir) }.to_bytes();
        return Some(PathBuf::from(std::ffi::OsStr::from_bytes(bytes)));
    }
}

#[cfg(windows)]
fn os_home() -> Option<PathBuf> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt};
    use windows_sys::Win32::{
        System::Com::CoTaskMemFree,
        UI::Shell::{FOLDERID_Profile, SHGetKnownFolderPath},
    };
    let mut path = std::ptr::null_mut();
    let status =
        unsafe { SHGetKnownFolderPath(&FOLDERID_Profile, 0, std::ptr::null_mut(), &mut path) };
    if status < 0 || path.is_null() {
        if !path.is_null() {
            unsafe { CoTaskMemFree(path.cast()) };
        }
        return None;
    }
    // The shell owns a NUL-terminated UTF-16 path, released even on a bad result.
    let mut length = 0;
    while length < 32768 && unsafe { *path.add(length) } != 0 {
        length += 1;
    }
    let home = if length == 32768 {
        None
    } else {
        Some(PathBuf::from(OsString::from_wide(unsafe {
            std::slice::from_raw_parts(path, length)
        })))
    };
    unsafe { CoTaskMemFree(path.cast()) };
    home
}

#[cfg(not(any(unix, windows)))]
fn os_home() -> Option<PathBuf> {
    None
}

pub(crate) fn read(path: &Path) -> Result<Credential, ()> {
    if !path.is_absolute() {
        return Err(());
    }
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| ())?;
    db.busy_timeout(Duration::from_secs(1)).map_err(|_| ())?;
    // Bound the record before copying it out of SQLite. No schema, pragmas that
    // mutate storage, refresh calls, or writable connection are ever used.
    let raw: Option<Option<String>> = db.query_row(
        "SELECT CASE WHEN length(value) <= 1048576 THEN value ELSE NULL END FROM credentials WHERE id = ?1",
        ["active"], |row| row.get(0),
    ).optional().map_err(|_| ())?;
    let raw = raw.flatten().ok_or(())?;
    drop(db);
    parse(&raw)
}

fn parse(raw: &str) -> Result<Credential, ()> {
    let value: Value = serde_json::from_str(raw).map_err(|_| ())?;
    let provider = match (value["kind"].as_str(), value["provider"].as_str()) {
        (Some("social"), Some("google")) => "google",
        (Some("social"), Some("github")) => "github",
        (Some("oidc"), Some("builder-id")) => "builder-id",
        (Some("oidc"), Some("identity-center")) => "identity-center",
        _ => return Err(()),
    };
    let nonempty = |key: &str| value[key].as_str().filter(|s| !s.is_empty()).ok_or(());
    if value["kind"] == "oidc" {
        for key in ["client_id", "client_secret", "region"] {
            nonempty(key)?;
        }
    }
    let access_token = nonempty("access_token")?.to_owned();
    let expires_at = DateTime::parse_from_rfc3339(nonempty("expires_at")?)
        .map_err(|_| ())?
        .with_timezone(&Utc);
    let profile_arn = match value.get("profile_arn") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if value.is_empty() => None,
        Some(Value::String(value)) => Some(value.clone()),
        _ => return Err(()),
    };
    Ok(Credential {
        access_token,
        expires_at,
        profile_arn,
        provider,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    pub(super) fn store(path: &Path, provider: &str) {
        let db = Connection::open(path).unwrap();
        db.execute(
            "CREATE TABLE credentials (id TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO credentials VALUES ('active', ?1)",
            [json!({
                "kind":"social", "provider":provider, "access_token":"private-token",
                "expires_at":"2099-01-01T00:00:00Z"
            })
            .to_string()],
        )
        .unwrap();
    }

    #[test]
    fn auth_paths_use_only_supplied_scope_environment() {
        let directory = tempfile::tempdir().unwrap();
        let os_home = directory.path().join("os-home");
        let session_home = directory.path().join("session-home");
        let config = directory.path().join("session-config");
        let custom = directory.path().join("custom").join("auth.db");
        let mut env = BTreeMap::new();
        assert_eq!(
            auth_path_with_home(&env, || Some(os_home.clone())).unwrap(),
            os_home.join(".config/omp-kiro/auth.sqlite3")
        );
        env.insert("HOME".into(), session_home.to_str().unwrap().into());
        assert_eq!(
            auth_path_with_home(&env, || panic!("must not use OS fallback")).unwrap(),
            session_home.join(".config/omp-kiro/auth.sqlite3")
        );
        env.insert("XDG_CONFIG_HOME".into(), "relative".into());
        assert!(
            auth_path_with_home(&env, || None)
                .unwrap()
                .starts_with(&session_home)
        );
        env.insert("XDG_CONFIG_HOME".into(), config.to_str().unwrap().into());
        assert_eq!(
            auth_path_with_home(&env, || None).unwrap(),
            config.join("omp-kiro/auth.sqlite3")
        );
        env.insert("OMP_KIRO_AUTH_FILE".into(), "relative.sqlite3".into());
        assert!(auth_path_with_home(&env, || None).is_err());
        env.insert("OMP_KIRO_AUTH_FILE".into(), custom.to_str().unwrap().into());
        assert_eq!(auth_path_with_home(&env, || None).unwrap(), custom);
    }

    #[test]
    fn auth_read_is_read_only_and_never_creates_missing_storage() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing.db");
        assert!(read(&missing).is_err());
        assert!(!missing.exists());
        let path = dir.path().join("auth.db");
        store(&path, "github");
        let before = std::fs::read(&path).unwrap();
        assert_eq!(read(&path).unwrap().provider, "github");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn auth_rejects_signed_out_malformed_and_incomplete_oidc() {
        for value in [
            json!({"kind":"logged-out"}),
            json!({"kind":"social","provider":"untrusted","access_token":"x","expires_at":"2099-01-01T00:00:00Z"}),
            json!({"kind":"oidc","provider":"builder-id","access_token":"x","expires_at":"2099-01-01T00:00:00Z"}),
        ] {
            assert!(parse(&value.to_string()).is_err());
        }
        assert!(parse("not json").is_err());
    }
}
