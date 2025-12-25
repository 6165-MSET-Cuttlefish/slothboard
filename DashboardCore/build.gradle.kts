plugins {
	id("dev.frozenmilk.jvm-library") version "10.2.0-0.1.3"
	id("dev.frozenmilk.doc") version "0.0.4"
	id("org.gradle.checkstyle")
	`maven-publish`
}

checkstyle {
	toolVersion = "8.18"
}

repositories {
	mavenCentral()
}

dependencies {
	//noinspection GradleDependency
	compileOnly("com.google.code.gson:gson:2.8.6")

	testImplementation("com.google.code.gson:gson:2.8.6")

	testImplementation("org.junit.jupiter:junit-jupiter:5.9.1")

	testImplementation("org.nanohttpd:nanohttpd-websocket:2.3.1")
}

group = findProperty("slothboard.group") as String? ?: "com.acmerobotics.slothboard"
version = findProperty("slothboard.version") as String? ?: "1.0.0"

publishing {
	publications {
		register<MavenPublication>("release") {
			groupId = "com.acmerobotics.slothboard"
			artifactId = "core"

			artifact(dairyDoc.dokkaHtmlJar)
			artifact(dairyDoc.dokkaJavadocJar)

			afterEvaluate {
				from(components["java"])
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
