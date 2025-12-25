import com.android.build.gradle.internal.tasks.factory.dependsOn

plugins {
	id("com.github.node-gradle.node") version "2.2.4"
	id("dev.frozenmilk.android-library") version "10.3.0-0.1.4"
	id("dev.frozenmilk.doc") version "0.0.5"
	id("dev.frozenmilk.build-meta-data") version "0.0.1"
	id("org.gradle.checkstyle")
	`maven-publish`
}

android.namespace = "com.acmerobotics.dashboard"

checkstyle {
	toolVersion = "8.18"
}

node {
	version = "16.20.2"
	download = true
	nodeModulesDir = file("${project.projectDir}/../client")
}

val yarnBuild = tasks.named("yarn_build")
val yarnInstall = tasks.named("yarn_install")

yarnBuild.dependsOn(yarnInstall)

val cleanDashAssets by tasks.registering(Delete::class) {
	delete("${android.sourceSets.getByName("main").assets.srcDirs.first()}/dash")
}

tasks.named("clean").dependsOn(cleanDashAssets)

val copyDashAssets by tasks.registering(Copy::class) {
	from("${project.projectDir}/../client/dist")
	into("${android.sourceSets.getByName("main").assets.srcDirs.first()}/dash")
}

copyDashAssets.dependsOn(cleanDashAssets)
copyDashAssets.dependsOn(yarnBuild)

android.libraryVariants.all {
	preBuildProvider.get().dependsOn(copyDashAssets)
}

android {
	defaultConfig {
		consumerProguardFiles("proguard-rules.pro")
	}
}

ftc {
	kotlin
	sdk {
		configurationNames = setOf("api")
		RobotCore
		Hardware
		RobotServer
		FtcCommon
	}
}

repositories {
	files("../libs")
	mavenCentral()

	maven {
		name = "dairyReleases"
		url = uri("https://repo.dairy.foundation/releases")
	}
}

group = findProperty("slothboard.group") as String? ?: "com.acmerobotics.slothboard"
version = findProperty("slothboard.version") as String? ?: "1.0.0"

dependencies {
	api("com.acmerobotics.slothboard:core:${version}") {
		isTransitive = false
	}

	implementation("dev.frozenmilk.sinister:Sloth:0.2.4")

	implementation("org.nanohttpd:nanohttpd-websocket:2.3.1") {
		exclude(module = "nanohttpd")
	}
}

meta {
	packagePath = "com.acmerobotics.dashboard"
	name = "Dashboard"
	registerField("name", "String", "\"com.acmerobotics.slothboard.Dashboard\"")
	
	// Use dynamic values based on git state
	val gitBranch = providers.exec {
		commandLine("git", "rev-parse", "--abbrev-ref", "HEAD")
	}.standardOutput.asText.get().trim()
	
	val gitClean = providers.exec {
		commandLine("git", "status", "--porcelain")
	}.standardOutput.asText.get().isEmpty()
	
	registerField("clean", "Boolean", "$gitClean")
	registerField("gitRef", "String", "\"$gitBranch\"")
	registerField("snapshot", "Boolean", "${version.toString().contains("SNAPSHOT", ignoreCase = true)}")
	registerField("version", "String", "\"$version\"")
}

publishing {
	publications {
		register<MavenPublication>("release") {
			groupId = "com.acmerobotics.slothboard"
			artifactId = "dashboard"

			artifact(dairyDoc.dokkaHtmlJar)
			artifact(dairyDoc.dokkaJavadocJar)

			afterEvaluate {
				from(components["release"])
			}

			pom {
				description = "Web dashboard designed for FTC"
				name = "FTC Dashboard"
				url = "https://github.com/6165-MSET-CuttleFish/slothboard"

				licenses {
					license {
						name = "The MIT License"
						url = "https://opensource.org/licenses/MIT"
						distribution = "repo"
					}
				}

				developers {
					developer {
						id = "rbrott"
						name = "Ryan Brott"
						email = "rcbrott@gmail.com"
					}
				}

				scm {
					url = "https://github.com/6165-MSET-CuttleFish/slothboard"
				}
			}
		}
	}
}
