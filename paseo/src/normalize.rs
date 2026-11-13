use chrono::{DateTime, SecondsFormat, Utc};
use paseo_plugin::usage::{Balance, Detail, Report, Unit, Window};
use serde_json::{Map, Value};

type Object = Map<String, Value>;
type Result<T, E = Failure> = std::result::Result<T, E>;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Failure {
    InvalidResponse,
    UnknownExpiry,
    NoQuota,
}
impl Failure {
    pub fn message(self) -> &'static str {
        match self {
            Self::InvalidResponse => "Kiro returned an unrecognized usage response.",
            Self::UnknownExpiry => "Kiro did not report a valid quota reset or expiry date.",
            Self::NoQuota => "Kiro did not report a supported account quota.",
        }
    }
}
fn object(value: &Value) -> Result<&Object> {
    value.as_object().ok_or(Failure::InvalidResponse)
}
fn list(value: &Value) -> Result<&Vec<Value>> {
    value.as_array().ok_or(Failure::InvalidResponse)
}
fn number(value: &Value) -> Result<f64> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0)
        .ok_or(Failure::InvalidResponse)
}
fn precise(value: &Object, field: &str, precision_field: &str) -> Result<f64> {
    number(
        value
            .get(precision_field)
            .filter(|v| !v.is_null())
            .or_else(|| value.get(field))
            .unwrap_or(&Value::Null),
    )
}
fn date(value: &Value) -> Result<DateTime<Utc>> {
    let seconds = value
        .as_f64()
        .filter(|v| v.is_finite() && *v > 0.0)
        .ok_or(Failure::UnknownExpiry)?;
    let millis = (seconds * 1000.0).trunc();
    // Match ECMAScript Date's TimeClip bound as well as chrono's range.
    if !millis.is_finite() || millis > 8.64e15 {
        return Err(Failure::UnknownExpiry);
    }
    DateTime::from_timestamp_millis(millis as i64).ok_or(Failure::UnknownExpiry)
}
fn iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn get<'a>(obj: &'a Object, key: &str) -> &'a Value {
    obj.get(key).unwrap_or(&Value::Null)
}
fn present(obj: &Object, key: &str) -> bool {
    obj.get(key).is_some_and(|v| !v.is_null())
}

#[derive(Default)]
struct Quotas {
    windows: Vec<Window>,
    balances: Vec<Balance>,
    details: Vec<Detail>,
}
impl Quotas {
    fn pool(
        &mut self,
        id: String,
        label: String,
        source: &Value,
        expiry: &Value,
        summary: bool,
        expired: bool,
        now: DateTime<Utc>,
    ) -> Result<(f64, f64)> {
        let source = object(source)?;
        let used = precise(source, "currentUsage", "currentUsageWithPrecision")?;
        let limit = precise(source, "usageLimit", "usageLimitWithPrecision")?;
        let reset = date(expiry)?;
        let expired = expired || reset <= now;
        let remaining = if expired {
            0.0
        } else {
            (limit - used).max(0.0)
        };
        let resets_at = iso(reset);
        self.balances.push(Balance {
            id: id.clone(),
            label: if expired {
                format!("{label} (expired)")
            } else {
                label.clone()
            },
            unit: Unit::Credits,
            used: Some(used),
            remaining: Some(remaining),
            limit: Some(limit),
            resets_at: Some(resets_at.clone()),
            tone: None,
        });
        if !expired {
            let used_pct = (limit > 0.0).then(|| used / limit * 100.0);
            let remaining_pct = (limit > 0.0).then(|| remaining / limit * 100.0);
            if used_pct.is_some_and(|v| !v.is_finite())
                || remaining_pct.is_some_and(|v| !v.is_finite())
            {
                return Err(Failure::InvalidResponse);
            }
            self.windows.push(Window {
                id,
                label,
                short_label: None,
                summary: summary.then_some(true),
                used_pct,
                remaining_pct,
                resets_at: Some(resets_at),
                runs_out_at: None,
                shortfall_pct: None,
                tone: None,
            });
        }
        Ok((used, limit))
    }
    fn detail(&mut self, id: String, label: String, value: String) {
        self.details.push(Detail {
            id,
            label,
            value,
            tone: None,
        });
    }
    fn charge(&mut self, id: String, label: String, used: f64, unit: Unit, resets_at: &str) {
        self.balances.push(Balance {
            id,
            label,
            used: Some(used),
            remaining: None,
            limit: None,
            unit,
            resets_at: Some(resets_at.into()),
            tone: None,
        });
    }
}

pub(crate) fn normalize(payload: &Value, now: DateTime<Utc>) -> Result<Report> {
    let payload = object(payload)?;
    // The service is not paginated. Never present an apparently complete partial response.
    if get(payload, "nextToken")
        .as_str()
        .is_some_and(|v| !v.is_empty())
        || get(payload, "nextToken").as_bool() == Some(true)
        || get(payload, "nextToken").is_object()
        || get(payload, "nextToken").is_array()
        || get(payload, "nextToken").as_f64().is_some_and(|v| v != 0.0)
    {
        return Err(Failure::InvalidResponse);
    }
    let rows = list(get(payload, "usageBreakdownList"))?;
    if rows.is_empty() {
        return Err(Failure::NoQuota);
    }
    let plan_label = match get(payload, "subscriptionInfo")
        .get("type")
        .and_then(Value::as_str)
    {
        Some("Q_DEVELOPER_STANDALONE") => Some("Kiro"),
        Some("Q_DEVELOPER_STANDALONE_FREE") => Some("Kiro Free"),
        Some("Q_DEVELOPER_STANDALONE_PRO") => Some("Kiro Pro"),
        Some("Q_DEVELOPER_STANDALONE_PRO_PLUS") => Some("Kiro Pro+"),
        Some("Q_DEVELOPER_STANDALONE_PRO_MAX") => Some("Kiro Pro Max"),
        Some("Q_DEVELOPER_STANDALONE_POWER") => Some("Kiro Power"),
        Some("Q_DEVELOPER_STANDALONE_STUDENT") => Some("Kiro Student"),
        _ => None,
    }
    .map(str::to_owned);
    let mut report = Quotas::default();
    if let Some(status) = get(payload, "overageConfiguration").get("overageStatus") {
        let label = match status.as_str() {
            Some("ENABLED") => "Enabled",
            Some("DISABLED") => "Disabled",
            _ => return Err(Failure::InvalidResponse),
        };
        report.detail(
            "overage-status".into(),
            "On-demand usage".into(),
            label.into(),
        );
    }
    for (index, raw) in rows.iter().enumerate() {
        let row = object(raw)?;
        if get(row, "resourceType") != "CREDIT" {
            return Err(Failure::NoQuota);
        }
        let (prefix, suffix) = if rows.len() == 1 {
            ("credits".into(), String::new())
        } else {
            (format!("credits-{}", index + 1), format!(" {}", index + 1))
        };
        let reset = row
            .get("nextDateReset")
            .filter(|v| !v.is_null())
            .unwrap_or_else(|| get(payload, "nextDateReset"));
        let reset_date = date(reset)?;
        if reset_date <= now {
            return Err(Failure::UnknownExpiry);
        }
        let resets_at = iso(reset_date);
        report.pool(
            format!("{prefix}-base"),
            format!("Monthly credits{suffix}"),
            raw,
            reset,
            true,
            false,
            now,
        )?;
        if present(row, "freeTrialInfo") {
            let trial = object(get(row, "freeTrialInfo"))?;
            let expired = match get(trial, "freeTrialStatus").as_str() {
                Some("ACTIVE") => false,
                Some("EXPIRED") => true,
                _ => return Err(Failure::InvalidResponse),
            };
            report.pool(
                format!("{prefix}-trial"),
                format!("Trial credits{suffix}"),
                get(row, "freeTrialInfo"),
                get(trial, "freeTrialExpiry"),
                false,
                expired,
                now,
            )?;
        }
        if present(row, "bonuses") {
            for (i, bonus) in list(get(row, "bonuses"))?.iter().enumerate() {
                let source = object(bonus)?;
                let expired = match get(source, "status").as_str() {
                    Some("ACTIVE") => false,
                    Some("EXPIRED") => true,
                    _ => return Err(Failure::InvalidResponse),
                };
                // Codes, descriptions and user-chosen labels are intentionally not exposed.
                report.pool(
                    format!("{prefix}-bonus-{}", i + 1),
                    format!("Bonus credits{suffix} {}", i + 1),
                    bonus,
                    get(source, "expiresAt"),
                    false,
                    expired,
                    now,
                )?;
            }
        }
        let metadata = if present(row, "addOnMetadata") {
            Some(object(get(row, "addOnMetadata"))?)
        } else {
            None
        };
        let empty = Vec::new();
        let addons = match metadata {
            Some(metadata) => list(get(metadata, "addOns"))?,
            None if present(row, "overageCredits") => list(get(row, "overageCredits"))?,
            None => &empty,
        };
        let (mut addon_used, mut addon_limit) = (0.0, 0.0);
        for (i, addon) in addons.iter().enumerate() {
            let (used, limit) = report.pool(
                format!("{prefix}-addon-{}", i + 1),
                format!("Add-on credits{suffix} {}", i + 1),
                addon,
                get(object(addon)?, "expiresAt"),
                false,
                false,
                now,
            )?;
            addon_used += used;
            addon_limit += limit;
        }
        if let Some(metadata) = metadata {
            let matches =
                |a: f64, b: f64| b.is_finite() && (a - b).abs() <= a.max(b).max(1.0) * 1e-10;
            if !matches(number(get(metadata, "addOnTotalUsage"))?, addon_used)
                || !matches(number(get(metadata, "addOnTotalLimit"))?, addon_limit)
            {
                return Err(Failure::InvalidResponse);
            }
        }
        if row.contains_key("currentOverages") || row.contains_key("currentOveragesWithPrecision") {
            report.charge(
                format!("{prefix}-overage"),
                format!("On-demand credits used{suffix}"),
                precise(row, "currentOverages", "currentOveragesWithPrecision")?,
                Unit::Credits,
                &resets_at,
            );
        }
        if row.contains_key("overageCharges") {
            if get(row, "currency") != "USD" {
                return Err(Failure::InvalidResponse);
            }
            report.charge(
                format!("{prefix}-charges"),
                format!("On-demand charges{suffix}"),
                number(get(row, "overageCharges"))?,
                Unit::Usd,
                &resets_at,
            );
        }
        if row.contains_key("overageCap") || row.contains_key("overageCapWithPrecision") {
            report.detail(
                format!("{prefix}-overage-cap"),
                format!("Service overage cap{suffix}"),
                precise(row, "overageCap", "overageCapWithPrecision")?.to_string(),
            );
        }
        if row.contains_key("overageRate") {
            if get(row, "currency") != "USD" {
                return Err(Failure::InvalidResponse);
            }
            report.detail(
                format!("{prefix}-overage-rate"),
                format!("On-demand USD per credit{suffix}"),
                number(get(row, "overageRate"))?.to_string(),
            );
        }
    }
    if present(payload, "totalUsage") {
        let total = object(get(payload, "totalUsage"))?;
        for (key, id, label) in [
            (
                "maxOverageLimit",
                "total-overage-limit",
                "Total service overage limit",
            ),
            (
                "totalOverageCharges",
                "total-overage-charges",
                "Total service overage charges",
            ),
        ] {
            if total.contains_key(key) {
                report.detail(
                    id.into(),
                    label.into(),
                    number(get(total, key))?.to_string(),
                );
            }
        }
    }
    Ok(Report::Available {
        plan_label,
        windows: report.windows,
        balances: Some(report.balances),
        details: Some(report.details),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn now() -> DateTime<Utc> {
        DateTime::from_timestamp(2_000_000_000, 0).unwrap()
    }
    fn payload() -> Value {
        json!({"nextDateReset":2_000_100_000,"usageBreakdownList":[{"resourceType":"CREDIT","currentUsage":10,"currentUsageWithPrecision":10.25,"usageLimit":100,"usageLimitWithPrecision":100.5}]})
    }
    fn output(value: &Value) -> Value {
        serde_json::to_value(normalize(value, now()).unwrap()).unwrap()
    }

    #[test]
    fn quota_precision_zero_limit_and_overuse_boundaries() {
        let mut value = payload();
        let result = output(&value);
        assert_eq!(result["balances"][0]["used"], 10.25);
        assert_eq!(result["balances"][0]["remaining"], 90.25);
        assert_eq!(result["windows"][0]["summary"], true);
        value["usageBreakdownList"][0]["usageLimitWithPrecision"] = json!(0);
        assert!(output(&value)["windows"][0]["usedPct"].is_null());
        assert_eq!(output(&value)["balances"][0]["remaining"], 0.0);
        value["usageBreakdownList"][0]["usageLimitWithPrecision"] = json!(5);
        let used_pct = output(&value)["windows"][0]["usedPct"].as_f64().unwrap();
        assert!((used_pct - 205.0).abs() < 1e-10);
        assert_eq!(output(&value)["windows"][0]["remainingPct"], 0.0);
    }

    #[test]
    fn quota_row_reset_precedes_global_and_stale_monthly_fails() {
        let mut value = payload();
        value["usageBreakdownList"][0]["nextDateReset"] = json!(2_000_200_000);
        assert_eq!(
            output(&value)["windows"][0]["resetsAt"],
            iso(DateTime::from_timestamp(2_000_200_000, 0).unwrap())
        );
        value["usageBreakdownList"][0]["nextDateReset"] = json!(2_000_000_000);
        assert_eq!(
            normalize(&value, now()).unwrap_err(),
            Failure::UnknownExpiry
        );
        value["usageBreakdownList"][0]["nextDateReset"] = Value::Null;
        assert_eq!(
            output(&value)["windows"][0]["resetsAt"],
            iso(DateTime::from_timestamp(2_000_100_000, 0).unwrap())
        );
        value["nextToken"] = json!("unconsumed-page");
        assert_eq!(
            normalize(&value, now()).unwrap_err(),
            Failure::InvalidResponse
        );
    }

    #[test]
    fn quota_expired_trial_bonus_and_addons_have_no_windows_or_remaining() {
        let mut value = payload();
        let row = &mut value["usageBreakdownList"][0];
        row["freeTrialInfo"] = json!({"currentUsage":1,"usageLimit":20,"freeTrialStatus":"EXPIRED","freeTrialExpiry":2_000_100_000});
        row["bonuses"] = json!([{"currentUsage":2,"usageLimit":30,"status":"ACTIVE","expiresAt":2_000_000_000,"description":"private-description","bonusCode":"private-code"}]);
        row["overageCredits"] =
            json!([{"currentUsage":3,"usageLimit":40,"expiresAt":1_999_999_999}]);
        let result = output(&value);
        assert_eq!(result["windows"].as_array().unwrap().len(), 1);
        for balance in result["balances"].as_array().unwrap().iter().skip(1) {
            assert_eq!(balance["remaining"], 0.0);
            assert!(balance["label"].as_str().unwrap().ends_with("(expired)"));
        }
        assert!(!result.to_string().contains("private-"));
    }

    #[test]
    fn quota_addon_metadata_deduplicates_legacy_and_checks_totals() {
        let mut value = payload();
        let row = &mut value["usageBreakdownList"][0];
        row["overageCredits"] =
            json!([{"currentUsage":999,"usageLimit":999,"expiresAt":2_000_100_000}]);
        row["addOnMetadata"] = json!({"addOns":[{"currentUsage":0.1,"usageLimit":1,"expiresAt":2_000_100_000},{"currentUsage":0.2,"usageLimit":2,"expiresAt":2_000_100_000}],"addOnTotalUsage":0.3,"addOnTotalLimit":3});
        assert_eq!(output(&value)["balances"].as_array().unwrap().len(), 3);
        value["usageBreakdownList"][0]["addOnMetadata"]["addOnTotalLimit"] = json!(4);
        assert_eq!(
            normalize(&value, now()).unwrap_err(),
            Failure::InvalidResponse
        );
    }

    #[test]
    fn quota_optional_plan_overages_and_details_are_not_credit_pools() {
        let mut value = payload();
        value["subscriptionInfo"] =
            json!({"type":"Q_DEVELOPER_STANDALONE_PRO_PLUS","email":"private-identity"});
        value["overageConfiguration"] = json!({"overageStatus":"DISABLED"});
        value["totalUsage"] = json!({"maxOverageLimit":50,"totalOverageCharges":1.25});
        let row = &mut value["usageBreakdownList"][0];
        row["currency"] = json!("USD");
        row["currentOverages"] = json!(2);
        row["currentOveragesWithPrecision"] = json!(2.75);
        row["overageCharges"] = json!(0.55);
        row["overageCap"] = json!(50);
        row["overageRate"] = json!(0.2);
        let result = output(&value);
        assert_eq!(result["planLabel"], "Kiro Pro+");
        assert_eq!(result["windows"].as_array().unwrap().len(), 1);
        assert_eq!(result["balances"][1]["used"], 2.75);
        assert_eq!(result["balances"][2]["unit"], "usd");
        assert!(result["balances"][1].get("remaining").is_none());
        assert_eq!(result["details"].as_array().unwrap().len(), 5);
        assert!(!result.to_string().contains("private-identity"));
        value["usageBreakdownList"][0]["currency"] = json!("EUR");
        assert_eq!(
            normalize(&value, now()).unwrap_err(),
            Failure::InvalidResponse
        );
    }

    #[test]
    fn quota_rejects_malformed_numbers_status_and_unsupported_resource() {
        for invalid in [json!(-1), json!("10"), json!(true)] {
            let mut value = payload();
            value["usageBreakdownList"][0]["currentUsageWithPrecision"] = invalid;
            assert_eq!(
                normalize(&value, now()).unwrap_err(),
                Failure::InvalidResponse
            );
        }
        let mut value = payload();
        value["usageBreakdownList"][0]["resourceType"] = json!("REQUEST");
        assert_eq!(normalize(&value, now()).unwrap_err(), Failure::NoQuota);
        value["usageBreakdownList"] = json!([]);
        assert_eq!(normalize(&value, now()).unwrap_err(), Failure::NoQuota);
    }
}
