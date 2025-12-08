pluginManagement {
	repositories {
		gradlePluginPortal()
		mavenCentral()
		google()
		maven("https://repo.dairy.foundation/releases")
	}
}

plugins {
	id("org.gradle.toolchains.foojay-resolver-convention") version "0.8.0"
}

includeBuild("../DashboardCore") {
	dependencySubstitution {
		substitute(module("com.acmerobotics.slothboard:core")).using(project(":"))
	}
}
