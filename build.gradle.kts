// Root build file for JitPack
// This file aggregates the DashboardCore and FtcDashboard modules for publishing

tasks.register("clean") {
	group = "build"
	description = "Cleans all modules"
	
	dependsOn(gradle.includedBuild("DashboardCore").task(":clean"))
	dependsOn(gradle.includedBuild("FtcDashboard").task(":clean"))
}

tasks.register("assemble") {
	group = "build"
	description = "Assembles all modules"
	
	// Build DashboardCore first, then FtcDashboard (which depends on it)
	dependsOn(gradle.includedBuild("DashboardCore").task(":assemble"))
	dependsOn(gradle.includedBuild("FtcDashboard").task(":assemble"))
}

tasks.register("publishToMavenLocal") {
	group = "publishing"
	description = "Publishes all modules to Maven Local"
	
	// Publish DashboardCore first, then FtcDashboard
	dependsOn(gradle.includedBuild("DashboardCore").task(":publishToMavenLocal"))
	dependsOn(gradle.includedBuild("FtcDashboard").task(":publishToMavenLocal"))
}
