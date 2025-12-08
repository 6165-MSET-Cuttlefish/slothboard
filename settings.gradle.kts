plugins {
	id("org.gradle.toolchains.foojay-resolver-convention") version "0.8.0"
}

includeBuild("DashboardCore") {
	dependencySubstitution {
		substitute(module("com.acmerobotics.slothboard:core")).using(project(":"))
	}
}

includeBuild("FtcDashboard")

includeBuild("TeamCode")