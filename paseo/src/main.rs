mod auth;
mod normalize;
mod source;
mod transport;

#[tokio::main(flavor = "current_thread")]
async fn main() -> paseo_plugin::Result<()> {
    let mut plugin = paseo_plugin::Plugin::new();
    let mut source = paseo_plugin::UsageSource::new(
        "kiro",
        "Kiro HTTP",
        |scope, context| async move {
            Ok(serde_json::to_value(
                source::discover(scope, &context.cancellation).await,
            )?)
        },
        |input, context| async move {
            Ok(serde_json::to_value(
                source::fetch(input, &context.cancellation).await,
            )?)
        },
    );
    source.icon = Some(include_str!("../../icon.svg").into());
    plugin.usage_source(source)?;
    plugin.run().await
}
