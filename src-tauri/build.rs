/// Distribution of this build: exactly `direct` or `store` (surrounding whitespace ignored); unset or empty is
/// `direct`. Anything else stops the build, so a typo can never ship as a direct build (the JS side throws too).
fn distribution_for(value: Option<&str>) -> Result<&'static str, String> {
    match value.map(str::trim) {
        None | Some("") | Some("direct") => Ok("direct"),
        Some("store") => Ok("store"),
        Some(other) => Err(format!(
            "BURROW_DISTRIBUTION must be direct or store (got \"{other}\")"
        )),
    }
}

/// Data location of this build: exactly `appdata` or `userprofile` (surrounding whitespace ignored); unset or empty is
/// `appdata`. `userprofile` (the data folder is %USERPROFILE%\Burrow Data, only for the Microsoft Store build) is valid only
/// together with the `store` distribution. Anything else stops the build.
fn data_location_for(value: Option<&str>, distribution: &str) -> Result<&'static str, String> {
    match value.map(str::trim) {
        None | Some("") | Some("appdata") => Ok("appdata"),
        Some("userprofile") if distribution == "store" => Ok("userprofile"),
        Some("userprofile") => Err(
            "BURROW_DATA_LOCATION=userprofile is only valid together with BURROW_DISTRIBUTION=store".to_string(),
        ),
        Some(other) => Err(format!(
            "BURROW_DATA_LOCATION must be appdata or userprofile (got \"{other}\")"
        )),
    }
}

fn main() {
    // `store` is set only by scripts/release/buildStore.mjs. channel.rs reads the result with env!, and rebuilds follow
    // the variable.
    println!("cargo:rerun-if-env-changed=BURROW_DISTRIBUTION");
    let raw = match std::env::var("BURROW_DISTRIBUTION") {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => {
            panic!("BURROW_DISTRIBUTION must be direct or store (it is not valid Unicode)")
        }
    };
    let distribution =
        distribution_for(raw.as_deref()).unwrap_or_else(|message| panic!("{message}"));
    println!("cargo:rustc-env=BURROW_BUILD_DISTRIBUTION={distribution}");
    // `userprofile` is set only by scripts/release/buildStore.mjs (data location of the Store build). channel.rs reads the
    // result with env!.
    println!("cargo:rerun-if-env-changed=BURROW_DATA_LOCATION");
    let location_raw = match std::env::var("BURROW_DATA_LOCATION") {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => {
            panic!("BURROW_DATA_LOCATION must be appdata or userprofile (it is not valid Unicode)")
        }
    };
    let data_location = data_location_for(location_raw.as_deref(), distribution)
        .unwrap_or_else(|message| panic!("{message}"));
    println!("cargo:rustc-env=BURROW_BUILD_DATA_LOCATION={data_location}");
    tauri_build::build();
}
